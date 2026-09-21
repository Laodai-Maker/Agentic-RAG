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


const llm = new ChatOpenAI({
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

const GraphState = Annotation.Root({
    questions:Annotation,
    k:Annotation,
    strategy:Annotation,
    routeReason:Annotation,
    // 召回
    retrievedDocs:Annotation,
    localContext:Annotation,// RAG 检索后的上下文
    webContext:Annotation,// 网络搜索后的上下文
    evalution:Annotation,
    generation:Annotation
})
let vectorStore;

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

const RouteSchema = z.object({
  // 枚举
  strategy: z.enum(["simple", "complex"]),
  reason: z.string()
});

const routeQuestionNode = async (state) => {
  console.log('___ROUTE-QUESTION___');
  // 结构化输出
  const router = llm.withStructuredOutput(RouteSchema);
  const route = await router.invoke(`
  你是问答路由器，请判断用户问题是否需要外部检索。

  规则：
  - simple: 常识问答、简短定义、无需特定小说细节即可回答。
  - complex: 需要《天龙八部》具体情节、任务关系、章节事实、原文细节或证据支持。
  
  用户问题： ${state.question}
  `);
 
  console.log(`路由策略：${route.strategy} ${route.reason}`)
  // 可选的， 不需要全部state 的设置 
  //  为后面的节点提供服务的 
  return {
    strategy: route.strategy,
    routeReason: route.reason,
    retrievedDocs: [],
    localContext: "",
    webContext: "",
    evaluation: "",
    generation: ""
  }
}

const directAnswerNode = async (state) => {
  console.log('----DIRECT_ANSWER----');
  process.stdout.write("\n [AI 回答（流式）] \n");
  let generation = "";
  const stream = await llm.stream(`你是一个中文回答助手,
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
    generation
  }
}

const retrieveLocalNode = async (state) => {
  console.log("---LOCAL_RETRIEVE---");
  const retrieveDocs = await retrieveRelevantContent(state.question, state.k);
  console.log(`本地检索命中:${retrieveDocs.length}条`);
  const localContext = (retrieveDocs ?? []).map((d) => d.content).join("\n\n");
  return {
    retrieveDocs,
    localContext
  }
}

const EvaluateSchema = z.object({
  enough: z.boolean(), // 是否足够生成，web search
  missing: z.array(z.string()).max(6), // 上下文缺的方面
  reason: z.string(),
  web_query: z.string().optional() // 可选的 web 搜索的关键词
})

// 评估节点
const evaluateNode = async (state) => {
  const hasWeb = Boolean(state.webContext && String(state.webContext).trim());
  console.log(hasWeb ? "---EVALUATE_CONTEXT_WITH_WEB---": "---EVALUATE_LOCAL_CONTEXT---");
  // llm 大脑， 规划， 分析， 分步骤
  const evaluator = llm.withStructuredOutput(EvaluateSchema);
  const out = await evaluator.invoke(`
    你是信息充分性评估器。判断当前上下文是否足以回答用户问题。
    用户问题： ${state.question}
    已检索上下文(来自本地知识库) :
    ${state.localContext || "  (空) "}
    ${hasWeb ? `联网搜索结果:\n ${state.webContext || "  (空) "}`: ""} 

    输出字段：
    - enough: 是否足够回答(true/false)
    - missing: 若不够，列出缺失信息点（最多6条）
    - reason: 简短原因
    ${hasWeb ? "": 
      "- web_query: 若不够， 给出一个适合互联网搜索的中文查询句（完整句， 不用代码： 为空也可）"}
  `);
  console.log(`${hasWeb ? "二次评估": "评估"}: 
    enough=${out.enough} (${out.reason})`);
  if (!out.enough && out.missing?.length) {
    out.missing.forEach((m, i) => console.log(`缺失 ${i+1}: ${m}`))
  }
  return {
    evaluation: JSON.stringify(out)
  }
}

const afterRoute = (state) => (state.strategy === 'simple'? "direct_answer" : "local_retrieve")

const generateNode = async (state) => {
  // 增强prompt
  // localContext
  // webContext
  console.log("---GENERATE---");
  const context = [state.localContext, state.webContext]
    .filter(Boolean)// Boolean 函数
    .join("\n\n==联网补充==\n\n");
  process.stdout.write("\n[AI 回答(流式)]\n");
  let generation = "";
  const stream = await llm.stream(`你是一个严谨的中文问答助手。
    优先依据上下文回答，不要编造。
    上下文（本地知识库 + 可选联网补充）:
    ${context || "(空)"}
    用户问题: ${state.question}

    回答要求：
    1. 如果上下文足够， 给出清晰， 可核对的回答： 需要时引用：n / URL 
    “或说小说片段来支撑。”
    2. 如果上下文仍不满足以确定关键事实，明确说明“不确定/无法从上下文确认”，
    并说明缺失点。
    3. 不要输出表情符号。

    回答：
  `);
  for await (const chunk of stream) {
    const text = typeof chunk.content === "string"? chunk.content: "";
    if (!text) continue;
    generation += text;
    process.stdout.write(text);
  }
  process.stdout.write("\n");
  return {
    generation
  }
}

const afterEvaluateLocal = (state) => {
  if (state.webContext && String(state.webContext).trim()) {
    return "generate"
  }
  const parsed = (() => {
    try {
      return JSON.parse(state.evaluation || "{}")
    } catch {
      return {};
    }
  })();
  return parsed.enough === true ? "generate": "web_search";
}

async function bochaWebSearch(query, count) {
  const apiKey = process.env.BOCHA_API_KEY;
  if (!apiKey) {
    throw new Error("Bocha Web Search 的API KEY 未配置（环境变量BOCHA_API_KEY）。")
  }
  const url = "https://api.bochaai.com/v1/web-search";
  const body = {
    query,
    freshness: "noLimit",
    summary: true, // 返回的内容， 做个总结
    count: count ?? 10
  }

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error(`搜索API 请求失败(网络错误): ${error.message}`)
  }
  // 先处理失败 
  // ok 200 语义化更好
  if (!response.ok) {
    // 二进制流 json() text()
    // 出错，打印出错信息 
    const errorText = await response.text().catch(() => "");
    throw new Error(`搜索API 请求失败，状态码:${response.status}, 
      错误信息：${errorText}`);
  }

  let json;
  try {
    json = await response.json(); 
  } catch(err) {
    throw new Error(`搜索结果解析失败：${err.message}`)
  }
  console.log(json, "///////////");
  const webpages = json.data.webPages?.value ?? [];
  if (!webpages.length) {
    return "未找到相关结果。"
  }

  return webpages
    .map((page, idx) => `引用: ${idx + 1}
      标题：${page.name}
      URL: ${page.url}
      摘要：${page.summary}
      网站名称：${page.siteName}
      网站图标：${page.siteIcon}
      发布时间：${page.dateLastCrawled}
    `)
    .join("\n\n")
}

const webSearchNode = async (state) => {
  console.log("---WEB_SEARCH---");
  const parsed = (() => {
    try {
      return JSON.parse(state.evaluation || "{}")
    } catch {
      return {};
    }
  })();
  const query = (parsed.web_query ?? "").trim() || state.question;
  console.log(`联网查询：${query}`);
  // 封装
  // 方便切换其他服务
  const webContext = await bochaWebSearch(query, 8);
  console.log(`联网结果长度：${webContext.length}`);
  return {
    webContext
  }
}

const graph = new StateGraph(GraphState)
  .addNode("route_question", routeQuestionNode)
  .addNode("direct_answer", directAnswerNode)
  .addNode("local_retrieve", retrieveLocalNode)
  .addNode("evaluate_local", evaluateNode)
  .addNode("generate", generateNode)
  .addNode("web_search", webSearchNode)
  .addEdge(START, "route_question")
  .addConditionalEdges("route_question", afterRoute, {
    direct_answer: "direct_answer",
    local_retrieve: "local_retrieve"
  })
  .addEdge("local_retrieve", "evaluate_local")
  .addConditionalEdges("evaluate_local", afterEvaluateLocal,  {
    generate: "generate",
    web_search: "web_search"
  })
  .addEdge("web_search", "evaluate_local")
  .addEdge("direct_answer", END)
  .addEdge("generate", END)
  .compile();

const drawable = await graph.getGraphAsync();
const mermaid = drawable.drawMermaid({ withStyles: true });
console.log(mermaid);

async function main() {
  const question = `请回答《天龙八部》小说里"雁门关事件"的主谋是谁， 并说明其儿子的最终结局；
  另外请补充： 在《天龙八部》2013版电视剧中，这段“雁门关事件”主要出现在哪几集？
  请给出可核对的来源链接。
  `
  const k = 8;

  console.log(`链接到Milvus。。。`);
  vectorStore = await Milvus.fromExistingCollection(embeddings, {
    collectionName: "ebook_collection",
    url: "localhost:19530",
    textField: "content",
    primaryField: "id",
    vectorField: "vector",
    indexCreateOptions: {
      metric_type: "COSINE",
      // 多层近邻网络图
      index_type: "HNSW",
      params: { M: 16, efConstruction: 200 },
      search_params: { ef: 64 }
    }
  });
  vectorStore.indexSearchParams = {
    metric_type: "COSINE",
    params: JSON.stringify({ef: 64})
  }
  
  console.log(`已连接`);
  try {
    await vectorStore.client.loadCollection({ collection_name: "ebook_collection" });
    console.log(`集合已经加载`);
  } catch(err) {
    console.log(`集合已处于加载状态`);
  }

  const result = await graph.invoke({
    question,
    k,
    strategy: "",
    routeReson: "",
    retrieveDocs: [],
    localContext: "",
    webContext: "",
    evaluation: "",
    generation: ""
  });
  if (result.generation?.trim()) {
    console.log(result.generation);
  }
}

main()