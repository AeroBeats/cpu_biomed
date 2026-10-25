FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# 图片上传目录：命名卷首次挂载时会沿用镜像里这个目录的属主，
# 不先建好并以 node 拥有的话，容器里的非 root 进程写不进去。
RUN mkdir -p /app/media && chown node:node /app/media

EXPOSE 8080
USER node
CMD ["node", "index.mjs"]
