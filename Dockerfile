FROM node:20-slim
WORKDIR /app

# package*.json だけ先にコピー
COPY package*.json ./
# lockfileなしでOK。dev依存を除いてインストール
RUN npm install --omit=dev

# ソース一式をコピー
COPY . .

# 起動
CMD ["node", "index.js"]
