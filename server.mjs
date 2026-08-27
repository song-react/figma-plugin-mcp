import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const bridgeUrl = process.env.FIGMA_LOCAL_BRIDGE || 'ws://127.0.0.1:18428/mcp';
const pending = new Map();
let bridge;
let bridgePromise;
let bridgeSequence = 0;

const tools = [
  {
    name: 'figma_list_sessions',
    description: '列出当前正在运行本地桥接插件的 Figma 文件会话。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'figma_get_selection',
    description: '批量读取 Figma 当前选区的节点、布局、样式、文本和子树。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '多文件同时在线时指定会话。' },
        depth: { type: 'integer', minimum: 0, maximum: 20, default: 6 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'figma_get_current_page',
    description: '读取当前页面及指定深度的完整节点树。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        depth: { type: 'integer', minimum: 0, maximum: 20, default: 4 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'figma_get_node',
    description: '按节点 ID 读取详细属性与子树，不经过 Figma REST API。',
    inputSchema: {
      type: 'object',
      required: ['nodeId'],
      properties: {
        sessionId: { type: 'string' },
        nodeId: { type: 'string' },
        depth: { type: 'integer', minimum: 0, maximum: 20, default: 6 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'figma_find_nodes',
    description: '按名称和节点类型批量查找当前页或整个文件，返回轻量节点信息。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        query: { type: 'string', default: '' },
        types: { type: 'array', items: { type: 'string' } },
        pageId: { type: 'string' },
        allPages: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'figma_get_variables',
    description: '一次读取当前文件的本地变量集合、模式和值。',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'figma_export_node',
    description: '通过 Plugin API 将节点原样导出为 SVG、PNG、JPG 或 PDF 并写入本地文件。',
    inputSchema: {
      type: 'object',
      required: ['nodeId', 'format', 'outputPath'],
      properties: {
        sessionId: { type: 'string' },
        nodeId: { type: 'string' },
        format: { type: 'string', enum: ['SVG', 'PNG', 'JPG', 'PDF'] },
        scale: { type: 'number', minimum: 0.01, maximum: 16, default: 1 },
        outputPath: { type: 'string', description: '包含文件名的绝对路径。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'figma_export_selection',
    description: '一次导出当前选中的全部节点，适合批量生成 SVG/PNG 资源。',
    inputSchema: {
      type: 'object',
      required: ['format', 'outputDir'],
      properties: {
        sessionId: { type: 'string' },
        format: { type: 'string', enum: ['SVG', 'PNG', 'JPG', 'PDF'] },
        scale: { type: 'number', minimum: 0.01, maximum: 16, default: 1 },
        outputDir: { type: 'string', description: '绝对目录路径。' },
        prefix: { type: 'string', default: '' },
      },
      additionalProperties: false,
    },
  },
];

const connectBridge = () => {
  if (bridge?.readyState === WebSocket.OPEN) return Promise.resolve(bridge);
  if (bridgePromise) return bridgePromise;
  bridgePromise = new Promise((resolve, reject) => {
    const socket = new WebSocket(bridgeUrl);
    const timeout = setTimeout(() => reject(new Error('连接本地 Figma bridge 超时')), 3000);
    socket.onopen = () => {
      clearTimeout(timeout);
      bridge = socket;
      bridgePromise = undefined;
      resolve(socket);
    };
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.type !== 'response') return;
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      clearTimeout(request.timeout);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      bridgePromise = undefined;
      reject(new Error('本地 Figma bridge 未启动'));
    };
    socket.onclose = () => {
      bridge = undefined;
      bridgePromise = undefined;
      for (const request of pending.values()) request.reject(new Error('Figma bridge 已断开'));
      pending.clear();
    };
  });
  return bridgePromise;
};

const bridgeCall = async (tool, args) => {
  const socket = await connectBridge();
  const requestId = `mcp-${Date.now()}-${++bridgeSequence}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Figma 插件响应超时'));
    }, tool.startsWith('figma_export') ? 120000 : 30000);
    pending.set(requestId, { resolve, reject, timeout });
    socket.send(JSON.stringify({ type: 'request', requestId, tool, args }));
  });
};

const safeName = value =>
  value.trim().replaceAll(/[\\/:*?"<>|]/g, '-').replaceAll(/\s+/g, '-').slice(0, 120) || 'figma-node';

const writeExport = async (asset, outputPath) => {
  const target = path.resolve(outputPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    asset.encoding === 'base64' ? Buffer.from(asset.data, 'base64') : asset.data
  );
  return { id: asset.id, name: asset.name, path: target, format: asset.format };
};

const callTool = async (name, args) => {
  const result = await bridgeCall(name, args ?? {});
  if (name === 'figma_export_node') return writeExport(result, args.outputPath);
  if (name === 'figma_export_selection') {
    const extension = args.format.toLowerCase();
    const written = [];
    await mkdir(path.resolve(args.outputDir), { recursive: true });
    for (const [index, asset] of result.entries()) {
      const filename = `${args.prefix ?? ''}${safeName(asset.name)}${index ? `-${index + 1}` : ''}.${extension}`;
      written.push(await writeExport(asset, path.join(args.outputDir, filename)));
    }
    return written;
  }
  return result;
};

const respond = message => process.stdout.write(`${JSON.stringify(message)}\n`);

const handle = async request => {
  if (!request.id) return;
  try {
    if (request.method === 'initialize') {
      return respond({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'local-figma-plugin-mcp', version: '1.0.0' },
        },
      });
    }
    if (request.method === 'ping') {
      return respond({ jsonrpc: '2.0', id: request.id, result: {} });
    }
    if (request.method === 'tools/list') {
      return respond({ jsonrpc: '2.0', id: request.id, result: { tools } });
    }
    if (request.method === 'tools/call') {
      const result = await callTool(request.params.name, request.params.arguments);
      return respond({
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      });
    }
    respond({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: `不支持的方法：${request.method}` },
    });
  } catch (error) {
    respond({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      },
    });
  }
};

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const end = buffer.indexOf('\n');
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (line) void handle(JSON.parse(line));
  }
});
