// 段誉遇到第一个神仙姐姐的画像,是谁的底子？
// 直接把query 向量化匹配不够准确
// 支持子问题才分的工作节点
import "dotenv/config";
import {
  ChatOpenAI, 
  OpenAIEmbeddings
} from "@langchain/openai";
import {
  Annotation,
  END,
  START,
  StateGraph
} from '@langchain/langgraph';
import { Milvus } from '@langchain/community/vectorstores/milvus';
import {trim, z} from 'zod';

const model = new ChatOpenAI({
  model: process.env.OPENAI_MODEL_NAME,
  temperature: 0,
  configuration: {
    baseURL: process.env.OPENAI_API_BASE_URL
  },
  apiKey: process.env.OPENAI_API_KEY
});
const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-v3",
  dimensions: 1024,
  apiKey: process.env.OPENAI_API_KEY,
  configuration: {
    baseURL: process.env.OPENAI_API_BASE_URL
  }
});

let vectorStore;

const GraphState = Annotation.Root({
  question: Annotation,
  k: Annotation,
  strategy: Annotation,
  routeReason: Annotation,
  subQuestions: Annotation,
  nextSubIdx: Annotation, // question[i]    跳出循环
  currentQuery: Annotation, // 当前的子问题
  retrievalCount: Annotation, 
  maxRetrievals: Annotation,
  plannedNext: Annotation,
  documents: Annotation,
  generation: Annotation
})

const RouteSchema = z.object({
  // 枚举
  strategy: z.enum(["simple", "complex"]),
  reason: z.string()
});
// llm 完成问题的分辨
// RouteSchema 结构化输出约束
// 判断是简单的问题还是复杂的问题，简单直接用大模型搜索返回，复杂要RAG然后返回
const routeQuestionNode = async (state) => {
  console.log('___ROUTE-QUESTION___');
  // 结构化输出
  const router = model.withStructuredOutput(RouteSchema);
  const route = await router.invoke(`
  你是问答路由器，请判断用户问题是否需要外部检索。

  规则：
  - simple: 常识问答、简短定义、无需特定小说细节即可回答。
  - complex: 需要《天龙八部》具体情节、任务关系、章节事实、原文细节或证据支持。
  
  用户问题： ${state.question}
  `);
 
  console.log(`路由策略：${route.strategy} ${route.reason}`)
  return {
    question: state.question,
    k: state.k,
    strategy: route.strategy,
    routeReason: route.reason,
    retrievalCount: 0,
    maxRetrievals: state.maxRetrievals ?? 8,
    documents: [],
    subQuestions: [],
    nextSubIdx: 0,
    currentQuery: "",
  }
}
//直接通过llm进行搜索后返回答案
const directAnswerNode = async (state) => {
  console.log('----DIRECT_ANSWER----');
  process.stdout.write("\n [AI 回答（流式）] \n");
  let generation = "";
  const stream = await model.stream(`你是一个中文回答助手,
  请直简洁回答问题。
  问题：${state.question}
  `)
  for await (const chunk of stream) {
    const text = typeof chunk.content === 'string'?chunk.content:"";
    if (!text) continue;
    generation += text;
    process.stdout.write(text);
  }
  process.stdout.write("\n");
  return {
    question: state.question,
    k: state.k,
    strategy: state.strategy,
    routeReason: state.routeReason,
    documents: [],
    generation
  }
}
//这里是在向量数据库中检索与问题最相似的前 k 条数据
async function retrieveRelevantContent(question, k = TOP_K) {
  try {
    const docsWithScores = 
      await vectorStore.similaritySearchWithScore(question, k);
    return docsWithScores.map(([doc, score]) => ({
      score,
      content: doc.pageContent,
      id: doc.metadata?.id ?? "unknown",
      book_id: doc.metadata?.book_id ?? "未知",
      chapter_num: doc.metadata?.chapter_num ?? "未知",
      index: doc.metadata?.index ?? "未知"
      // doc.pageContent 
      // doc.metadata 相关的字段
    }))
  } catch(error) {
    console.error("检索内容时出错：", error.message);
    return [];
  }
}
// 这段代码约束大模型返回 1～8 个字符串形式的子问题，以及说明拆分原因的字符串。
const DecomposeSchema = z.object({
  sub_questions: z.array(z.string()).min(1).max(8),
  reason: z.string()// reason 是指模型为什么要拆分
})

// plan llm + prompt 
// 给他身份 
// 这里是写了一个拆解函数
const decomposeQuestionNode = async (state) => {
  console.log("---DECOMPOSE_QUESTION---");
  const decomposer = model.withStructuredOutput(DecomposeSchema);
  const out = await decomposer.invoke(`
    你是《天龙八部》多跳问答的【子问题拆解器】。
    用户原始问题：
    ${state.question}
    
    任务：将问题拆成**有序**子问题列表 sub_questions, 用于**依次向量检索**。要求：
    1. 链式推理、多层关系、应果先后的问题，必须拆成多条；单跳即可答的也可只输出1条。
    2. 每条子问题必须是**可独立检索**的完整中文问句，**禁止**使用「他/她/此人/上文」等指代；可写全人物名与事件名。
    3. 顺序必须符合推理链：先搞清前置实体/事实，再查后续结论。
    4. **不要**把整句原题原样复制成唯一一条（除非确实无法拆分）；不要拆成过碎的关键词列表。
    5. 输出 1～8 条即可。

    请输出 sub_questions 与简短 reason。
  `);
  // 去重空格， 排除不需要的question
  const subQuestions = out.sub_questions.map((s) => s.trim()).filter(Boolean)
  if (subQuestions.length === 0) {
    throw new Error("decompose_question: sub_questions 为空")
  }
  
  console.log(`拆解${subQuestions.length}条子问题(${out.reason})`);
  subQuestions.forEach((q, i) => {
    console.log(`[${i+1}] ${q}`);
  });
  return {
    subQuestions,
    nextSubIdx: 0,
    currentQuery: subQuestions[0]
  }
}
// 将多轮向量检索结果合并去重，相同文档保留最高分，最后按相关度降序排列
const mergeUnique = (existingDocs, newDocs) => {
  // map key 可以是对象
  // has get 
  const map = new Map(); // es6 新增的HashMap 数据结构 key:value
  for (const d of [...existingDocs, ...newDocs]) {
    const key = String(d.id);
    const prev = map.get(key);
    if (!prev || Number(d.score) > Number(prev.score)) {
      map.set(key, d);
    }
  }
  return Array.from(map.values()).sort((a, b) => Number(b.score) - Number(a.score))
}

const retrieveNode = async (state) => {
  const subs = state.subQuestions ?? [];
  const idx = state.nextSubIdx ?? 0 ;
  const q = subs[idx]?.trim(); // 当前这一轮的问题

  if (!q) {
    throw new Error(`retrieve: 子问题下标${idx} 无有效文本 
      （共${subs.length}条）`)
  }

  const round = state.retrievalCount + 1;
  console.log(`----第${round}轮， 子问题 ${idx+1}/${subs.length}---`);
  console.log(`---查询 ${q} ---`);
  const newDocs = await retrieveRelevantContent(q, state.k);
  // 多轮retrieve 有可能重复， 会浪费资源 
  // 重复可能让llm 我们在强调，错觉
  const merged = mergeUnique(state.documents ?? [], newDocs);
  if (newDocs.length === 0) {
    console.log(`本轮未命中文档`)
  } else {
    console.log(`本轮命中${newDocs.length}条，累计去重后${merged.length}条`);
    newDocs.forEach((item, i) => {
      const preview = item.content.length > 120 
        ? `${item.content.substring(0, 120)}...`
        : item.content;
      console.log(`[R${i + 1}] score=${Number(item.score).toFixed(4)} 
      chapter=${item.chapter_num} index=${item.index}
      `);
      console.log(`${preview}`);
    })
  }

  return {
    documents: merged,
    retrievalCount: round,
    nextSubIdx: idx + 1,
    currentQuery: q
  }
}

const NextStepSchema = z.object({
  nextAction: z.enum(["retrieve", "generate"]),
  reason: z.string()
})


const planNextStepNode = async (state) => {
  console.log("---PLAN_NEXT_STEP---");
  const subs = state.subQuestions ?? [];
  const nextIdx = state.nextSubIdx ?? 0;
  const remaining = subs.length - nextIdx;

  const subList = subs.map((s, i) => `${i + 1}.${s} 
  ${i < nextIdx ? "已检索": i === nextIdx ? "(下一轮将检索，若选择继续)": 
    "未检索"}`).join("\n");
  
  const docStr = state.documents.length === 0 
    ? "(尚无检索结果)"
    : state.documents
      .slice(0, 6)
      .map((d, i) => 
        `[${i + 1}] score=${Number(d.score).toFixed(4)} 第${d.chapter_num}章：
        ${d.content.slice(0, 200)}`
      ).join("\n\n")
    
  const prompt = `你是多跳 RAG 规划器。检索查询已由前置步骤拆解为**有序子问题**,
  若需要继续检索， 下一轮将自动使用 [下一条子问题] 做向量检索， 你**不要**
  自拟新的检索句。
  用户原始问题： ${state.question}
  子问题序列：
  ${subList || "无"}
  
  已检索轮次：${state.retrievalCount}; 剩余未检索子问题条数：${remaining}
  做大检索轮数上限：${state.maxRetrievals}

  已召回文档摘要:
  ${docStr}

  请判断下一步：
  1） 已有足够依据回答用户原始问题 -> nextAction=generate
  2) 仍缺关键事实、且仍存在未检索的子问题、且未超过轮数上限 -> nextAction=retrieve
  硬性规则：
  - 若剩余未检索子问题条数为0, 必须 nextAction=generate。
  - 若已检索轮数已到达或超过最大检索轮数， 必须nextAction=generate。
  `;
  const planModel = model.withStructuredOutput(NextStepSchema);
  const { nextAction, reason } = await planModel.invoke(prompt);
  
  let finalNext = nextAction;
  if (state.retrievalCount >= state.maxRetrievals) finalNext = "generate";
  if (remaining <= 0) finalNext = "generate";
  console.log(`[决策] plannedNext=${finalNext} 
    (模型建议=${nextAction})(${reason})`)
  return {
    plannedNext: finalNext
  }
}

const generateNode = async (state) => {
  const context = state.documents
    .map((item, i) => `[片段 ${i+1}]
    章节: 第 ${item.chapter_num}章
    内容：${item.content}
    `).join("\n\n----------\n\n")
  const prompt = `
  你是一个专业的《天龙八部》小说助手。基于小说内容回答问题，用准确，详细的语言。
  请根据以下《天龙八部》小说片段内容回答问题：
  ${context}
  用户问题：${state.question}

  回答要求：
  1. 如果片段中有相关信息，请结合小说内容给出详细、准确的回答
  2. 可以综合多个片段的内容，提供完整的答案
  3. 如果片段中没有相关信息，请如实告知用户
  4. 回答要准确，符合小说的情节和人物设定
  5. 可以引用原文内容来支持你的回答

  AI 助手的回答：
  `
  process.stdout.write("\n[AI回答（流式）]\n");
  let generation = "";
  const stream = await model.stream(prompt);
  for await (const chunk of stream) {
    const text = typeof chunk.content === "string"?chunk.content: "";
    if (!text) continue;
    generation += text;
    process.stdout.write(text);
  }
  process.stdout.write("\n");

  return {
    question: state.question,
    k: state.k,
    documents: state.documents,
    generation
  }
}

const afterRoute = (state) => (state.strategy === 'simple'? "direct_answer" : "decompose_question")

const afterPlan = (state) => (state.plannedNext === "retrieve" ? "retrieve":"generate")


const graph = new StateGraph(GraphState)
  .addNode("route_question", routeQuestionNode)
  .addNode("direct_answer", directAnswerNode)
  .addNode("decompose_question", decomposeQuestionNode)
  .addNode("retrieve", retrieveNode)
  .addNode("plan_next_step", planNextStepNode)
  .addNode("generate", generateNode)
  // .addNode("retrieve", retrieveNode)
  // .addNode("rag_generate", generateNode)
  .addEdge(START, "route_question")
  .addConditionalEdges("route_question", afterRoute, {
    direct_answer: "direct_answer",
    decompose_question: "decompose_question"
  })
  .addEdge("decompose_question", "retrieve")
  .addEdge("retrieve", "plan_next_step")
  .addConditionalEdges("plan_next_step", afterPlan, {
    retrieve: "retrieve",
    generate: "generate"
  })
  // .addEdge("retrieve", "rag_generate")
  .addEdge("direct_answer", END)
  .addEdge("generate", END)
  .compile();

const drawable = await graph.getGraphAsync();
const mermaid = drawable.drawMermaid({ withStyles: true });
console.log(mermaid);



async function main () {
  // const question = "1+1=?";
  const question = `《天龙八部》中【四大恶人】排行第二的是谁？
  此人之子在身世揭晓前,其生父在武林中的公开身份是什么？`;
  const k = 5;
  vectorStore = await Milvus.fromExistingCollection(embeddings, {
    collectionName: "ebook_collection",
    url: "localhost:19530",
    textField: "content",
    primaryField: "id",
    vectorField: "vector",
    indexCreateOptions: {
      metric_type: "COSINE",
      index_type:"HNSW",
      params: { M: 16, efConstruction: 200},
      search_params: { ef: 64}
    }
  });
  vectorStore.indexSearchParams = {
    metric_type: "COSINE",
    params: JSON.stringify({ef:64})
  }

  try {
    await vectorStore.client.loadCollection({
      collection_name: "ebook_collection"
    });
    console.log("集合已加载;")
  } catch(error) {
    if (!error.message.includes("already loaded")) {
      throw error
    }
    console.log('集合已经处于加载zhaugntai');
  }

  const result = await graph.invoke({
    question,
    k: Number.isFinite(k)?k:5,
    strategy: "",
    routeReason: "",
    documents: [],
    generation: ""
  });

  // console.log(JSON.stringify(result));
  
}

main()
  .then(err => console.error(err))
