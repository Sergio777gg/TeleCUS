FROM node:24-bookworm-slim
RUN npm install --prefix /opt/node-red node-red@4.1.10 && mkdir /state && chown node:node /state
COPY --chown=node:node node-red/settings.cjs node-red/flows.json /opt/flows/
USER node
CMD ["node", "/opt/node-red/node_modules/node-red/red.js", "--userDir", "/state", "--settings", "/opt/flows/settings.cjs", "/opt/flows/flows.json"]
