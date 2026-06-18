# 使用官方 Node 20 镜像（项目 package.json 推荐 Node 20.x）
FROM node:20-slim

# 安装编译 node-pty 所需的 Python、make 和 C++ 编译器
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 复制依赖文件并安装
COPY package*.json ./
RUN npm install

# 复制项目所有文件
COPY . .

# 暴露程序运行端口（根据你的 index.js 实际端口修改，默认通常是 3000 或 8080）
EXPOSE 3000

# 启动命令
CMD ["npm", "start"]
