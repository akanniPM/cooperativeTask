FROM public.ecr.aws/d3j8x8q7/olympus-base-typescript:latest

WORKDIR /app

COPY . .

# Normalize line endings to LF so patches apply cleanly on Linux
RUN find /app/src -name "*.ts" | xargs sed -i 's/\r$//'

ENV NODE_ENV=development
ENV CI=true
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile; \
    elif [ -f yarn.lock ]; then \
      yarn install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then \
      npm ci; \
    elif [ -f package.json ]; then \
      npm install; \
    fi
RUN pnpm build

CMD ["/bin/bash"]
