const port = Number(process.env.FIGMA_LOCAL_PORT || 18428);
const plugins = new Map();
const routes = new Map();
let sequence = 0;

const send = (socket, message) => {
  if (socket?.readyState === 1) socket.send(JSON.stringify(message));
};

const sessions = () =>
  [...plugins.entries()].map(([sessionId, plugin]) => ({
    sessionId,
    ...plugin.meta,
    connectedAt: plugin.connectedAt,
  }));

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/plugin' || url.pathname === '/mcp') {
      return server.upgrade(request, {
        data: { role: url.pathname.slice(1), sessionId: undefined },
      })
        ? undefined
        : new Response('WebSocket upgrade failed', { status: 400 });
    }
    return Response.json({ ok: true, sessions: sessions() });
  },
  websocket: {
    open() {},
    message(socket, raw) {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return send(socket, { type: 'error', error: '消息不是有效 JSON' });
      }

      if (socket.data.role === 'plugin') {
        if (message.type === 'hello' && message.sessionId) {
          socket.data.sessionId = message.sessionId;
          plugins.set(message.sessionId, {
            socket,
            meta: message.meta ?? {},
            connectedAt: new Date().toISOString(),
          });
          return send(socket, { type: 'ready', sessionId: message.sessionId });
        }
        if (message.type === 'response' && message.requestId) {
          const client = routes.get(message.requestId);
          if (client) {
            routes.delete(message.requestId);
            send(client, message);
          }
        }
        return;
      }

      if (message.type === 'request' && message.requestId) {
        if (message.tool === 'figma_list_sessions') {
          return send(socket, {
            type: 'response',
            requestId: message.requestId,
            result: { sessions: sessions() },
          });
        }
        const requested = message.args?.sessionId;
        const available = sessions();
        const sessionId = requested ?? available.at(-1)?.sessionId;
        const plugin = sessionId ? plugins.get(sessionId) : undefined;
        if (!plugin) {
          return send(socket, {
            type: 'response',
            requestId: message.requestId,
            error: requested
              ? `Figma 插件会话 ${requested} 不在线`
              : '没有在线的 Figma 插件。请在目标文件中运行 Local Figma MCP Bridge。',
          });
        }
        const requestId = `${Date.now()}-${++sequence}`;
        routes.set(requestId, socket);
        const { sessionId: _, ...args } = message.args ?? {};
        send(plugin.socket, {
          type: 'request',
          requestId,
          tool: message.tool,
          args,
        });
      }
    },
    close(socket) {
      if (socket.data.role === 'plugin' && socket.data.sessionId) {
        const current = plugins.get(socket.data.sessionId);
        if (current?.socket === socket) plugins.delete(socket.data.sessionId);
      }
      for (const [requestId, client] of routes) {
        if (client === socket) routes.delete(requestId);
      }
    },
  },
});

console.error(`Local Figma bridge listening on ws://${server.hostname}:${server.port}`);
