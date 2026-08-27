figma.showUI(__html__, { width: 320, height: 128, themeColors: true });

const sessionId = `${figma.fileKey || 'local'}-${Date.now().toString(36)}`;

const normalize = value => {
  if (value === figma.mixed) return 'MIXED';
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'symbol') return String(value);
  if (Array.isArray(value)) return value.map(normalize);
  const result = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (typeof item !== 'function') result[key] = normalize(item);
  }
  return result;
};

const read = (node, key) => {
  try {
    return key in node ? normalize(node[key]) : undefined;
  } catch {
    return undefined;
  }
};

const serializePaint = paint => {
  const result = normalize(paint);
  if (paint?.type === 'SOLID' && paint.color) {
    const channel = value => Math.round(value * 255).toString(16).padStart(2, '0').toUpperCase();
    result.hex = `#${channel(paint.color.r)}${channel(paint.color.g)}${channel(paint.color.b)}`;
  }
  return result;
};

const serializeNode = (node, depth = 0) => {
  const result = { id: node.id, type: node.type, name: node.name };
  for (const key of [
    'visible', 'locked', 'opacity', 'blendMode', 'x', 'y', 'width', 'height', 'rotation',
    'absoluteBoundingBox', 'absoluteRenderBounds', 'relativeTransform', 'constraints',
    'layoutMode', 'layoutWrap', 'layoutAlign', 'layoutGrow', 'primaryAxisSizingMode',
    'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing',
    'counterAxisSpacing', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
    'clipsContent', 'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomRightRadius',
    'bottomLeftRadius', 'strokeWeight', 'strokeAlign', 'strokeCap', 'strokeJoin',
    'dashPattern', 'effects', 'exportSettings', 'boundVariables', 'componentProperties',
    'characters', 'fontName', 'fontSize', 'fontWeight', 'textAlignHorizontal',
    'textAlignVertical', 'textAutoResize', 'lineHeight', 'letterSpacing',
    'paragraphSpacing', 'paragraphIndent', 'textCase', 'textDecoration', 'fills', 'strokes',
  ]) {
    const value = read(node, key);
    if (value !== undefined) result[key] = key === 'fills' || key === 'strokes'
      ? (value === 'MIXED' ? value : node[key].map(serializePaint))
      : value;
  }
  if ('children' in node) {
    result.childCount = node.children.length;
    if (depth > 0) result.children = node.children.map(child => serializeNode(child, depth - 1));
  }
  return result;
};

const nodeById = async id => {
  const node = await figma.getNodeByIdAsync(id);
  if (!node) throw new Error(`找不到节点 ${id}`);
  if (node.type === 'PAGE') await node.loadAsync();
  return node;
};

const exportNode = async (node, format, scale = 1) => {
  if (!('exportAsync' in node)) throw new Error(`节点 ${node.id} 不支持导出`);
  if (format === 'SVG') {
    return {
      id: node.id,
      name: node.name,
      format,
      encoding: 'utf8',
      data: await node.exportAsync({ format: 'SVG_STRING' }),
    };
  }
  const settings = { format };
  if (format === 'PNG' || format === 'JPG') settings.constraint = { type: 'SCALE', value: scale };
  return {
    id: node.id,
    name: node.name,
    format,
    encoding: 'base64',
    data: figma.base64Encode(await node.exportAsync(settings)),
  };
};

const handlers = {
  figma_get_selection: async ({ depth = 6 }) => ({
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    nodes: figma.currentPage.selection.map(node => serializeNode(node, depth)),
  }),
  figma_get_current_page: async ({ depth = 4 }) => serializeNode(figma.currentPage, depth),
  figma_get_node: async ({ nodeId, depth = 6 }) => serializeNode(await nodeById(nodeId), depth),
  figma_find_nodes: async ({ query = '', types = [], pageId, allPages = false, limit = 100 }) => {
    if (allPages) await figma.loadAllPagesAsync();
    const root = pageId ? await nodeById(pageId) : allPages ? figma.root : figma.currentPage;
    const needle = query.toLocaleLowerCase();
    const nodes = root.findAll(node =>
      (!needle || node.name.toLocaleLowerCase().includes(needle)) &&
      (!types.length || types.includes(node.type))
    );
    return nodes.slice(0, limit).map(node => serializeNode(node, 0));
  },
  figma_get_variables: async () => {
    const [collections, variables] = await Promise.all([
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync(),
    ]);
    return {
      collections: collections.map(collection => normalize({
        id: collection.id,
        name: collection.name,
        modes: collection.modes,
        defaultModeId: collection.defaultModeId,
        variableIds: collection.variableIds,
      })),
      variables: variables.map(variable => normalize({
        id: variable.id,
        name: variable.name,
        description: variable.description,
        collectionId: variable.variableCollectionId,
        resolvedType: variable.resolvedType,
        valuesByMode: variable.valuesByMode,
        scopes: variable.scopes,
        codeSyntax: variable.codeSyntax,
      })),
    };
  },
  figma_export_node: async ({ nodeId, format, scale = 1 }) =>
    exportNode(await nodeById(nodeId), format, scale),
  figma_export_selection: async ({ format, scale = 1 }) =>
    Promise.all(figma.currentPage.selection.map(node => exportNode(node, format, scale))),
};

const hello = () => figma.ui.postMessage({
  type: 'hello',
  sessionId,
  meta: {
    fileKey: figma.fileKey,
    editorType: figma.editorType,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    selectionCount: figma.currentPage.selection.length,
  },
});

figma.ui.onmessage = async message => {
  if (message.type !== 'request') return;
  try {
    const handler = handlers[message.tool];
    if (!handler) throw new Error(`不支持的工具：${message.tool}`);
    figma.ui.postMessage({
      type: 'response',
      requestId: message.requestId,
      result: await handler(message.args || {}),
    });
  } catch (error) {
    figma.ui.postMessage({
      type: 'response',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

figma.on('selectionchange', hello);
figma.on('currentpagechange', hello);
hello();
