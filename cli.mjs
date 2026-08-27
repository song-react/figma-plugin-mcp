const [tool, rawArgs = '{}'] = Bun.argv.slice(2);

if (!tool) {
  console.error('用法：bun cli.mjs <tool> [JSON arguments]');
  process.exit(1);
}

const socket = new WebSocket(process.env.FIGMA_LOCAL_BRIDGE || 'ws://127.0.0.1:18428/mcp');
const requestId = `cli-${Date.now()}`;

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Figma bridge 响应超时')), 120000);
  socket.onopen = () =>
    socket.send(JSON.stringify({ type: 'request', requestId, tool, args: JSON.parse(rawArgs) }));
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (message.type !== 'response' || message.requestId !== requestId) return;
    clearTimeout(timeout);
    message.error ? reject(new Error(message.error)) : resolve(message.result);
  };
  socket.onerror = () => reject(new Error('无法连接本地 Figma bridge'));
}).then(result => console.log(JSON.stringify(result, null, 2)));

socket.close();
