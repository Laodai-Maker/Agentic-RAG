# Docker

### Docker 是什么？

容器

Docker 解决的是 软件的 运行环境问题

Docker 是一个应用容器化工具，解决一个应用能在不同的电脑上运行的问题

- 一个软件可能会依赖多个应用或者语言
  - redis
  - next
  - react
  - mysql
  - 应用可能会依托一堆有版本要求的运行环境
- Docker 就能把这一整个打包成一个整体的容器，这个容器可以非常方便的部署在任何设备上

<br />

Agent = LLM + Harness（tool + MCP + RAG + Skill + ... ）

Docker = 应用 + 运行环境

<br />

## 举例

你到公司接手一个 n 年前 Vue 2 的项目，要求使用 Node 16 + npm 8 进行重构

你的电脑装的是 node 22 ，此时项目就无法在你的项目中使用

此时使用 docker 进行容器化处理，就能在新电脑中使用了

docker 使用到了 虚拟化 技术，将各个依赖隔离化安装

<br />

## Docker 的基本概念

- image 就相当于 光盘
  - 包含 应用程序 + 环境 是隔离的
  - 可以拉取一个 image （git pull）
- container DVD 把 image 放到 container 中就可以运行

<br />

<br />

## Docker 的使用

- docker run <镜像>  根据镜像 创建并启动 一个新容器
- docker images 列出本地所有 镜像
- docker ps -a 列出所有 容器 （ -a 包括已停止的）
- docker pull <镜像名> 从仓库（如 Docker Hub）拉取镜像
- docker rmi <镜像ID> 删除镜像（必须先删掉用它的容器）
- docker stop <容器ID> 停止一个运行中的容器
- docker rm <容器ID> 删除容器（必须先停止）

<br />

## Web 简单应用

<http://localhost:1314/>

<https://juejin.cn/>

: 80 默认端口号

运维知识

服务器软件 把所有在 80 端口号产生的请求帮我们代理给 3000 （其他）端口，并为它提供服务

<br />

## Nginx 服务器

要满足 高并发，代理转发，需要 nginx
监听80端口的访问 
并通过配置文件帮我们转发给1314 端口

### 启动 Nginx image

- docker run
  - 启动一个镜像，成为可运行的容器
  --name my-nginx-demo 
  容器的名字 id 
  -p 80:80
  本机的80端口：容器的80
  80 是nginx 的监视端口
  http://localhost:80 用户的浏览器输入
  转给，映射给container 80
  -v E:\lv meng studing\workspace\ch_ai\backend\docker\demo\nginx.conf:/etc/nginx/nginx.conf
  80 代理1314端口
  -d nginx
  后台运行nginx 

  docker run --name my-nginx-demo -p 80:80 -v "E:\lv meng studing\workspace\ch_ai\backend\docker\demo\nginx.conf:/etc/nginx/nginx.conf" -d nginx

## 运维考点
- nginx
  反向代理 

  用户上网intent->  browser(chrome)（正向代理） ->
  local：80 -> docker -p(ort)  : container(80)  -> -v 映射配置文件(local:/etc/nginx/nginx.conf)  ->  -d (后台运行)
  nginx(image) ->nginx:80(nginx.conf 代理端口服务) 


  nginx:80（nginx.conf 代理端口服务） <- 1314(反向代理)
  localhost 我们是不知道后端具体在哪个端口上运行的

- docker
  pull 任何想要的镜像
  run 任何的镜像