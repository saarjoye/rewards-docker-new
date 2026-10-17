/**
 * Next.js Flight / RSC 数据流解析工具（纯函数，便于单测）。
 *
 * 背景：rewards.bing.com 的 /earn 页面把任务卡片数据塞在
 * `self.__next_f.push([1,"..."])` 的转义 JSON 片段里。
 *
 * 旧实现有两个缺陷，都会让「官网明明有卡片」被误判成 0 张：
 *   1. 用 /\{[^{}]*?"offerId"\s*:\s*"([^"]+)"[^{}]*?\}/ 抠对象 —— 不允许花括号嵌套，
 *      而卡片普遍带 attributes / destination 等子对象，正则整体失配；
 *   2. 用 indexOf('"activityCards":[') 找数组 —— 一旦引号被多转义一层就永远找不到，
 *      上层只能报「未能读取官网状态」。
 *
 * 这里统一改为：先把 Flight 片段还原成正常文本，再做「字符串感知 + 括号配平」扫描。
 * 纯函数、零依赖，方便回归测试。
 */

/** 判断 index 处的字符是否被反斜杠转义（处理偶数个反斜杠的情况）。 */
function isEscaped(text, index) {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

/**
 * 从 text[openIndex] 开始，找到与 open/close 配平的闭合下标（含）。
 * 字符串字面量内的括号不计入配平；找不到返回 -1。
 */
export function findBalancedEnd(text, openIndex, open = '[', close = ']') {
  if (!text || openIndex < 0 || text[openIndex] !== open) return -1;
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '"' && !isEscaped(text, i)) inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 还原被转义过一到多层的 Flight 片段。
 *
 * 例如 HTML 源码里出现 \\"activityCards\\" 或 \u0022activityCards\u0022 时，
 * 只 replace 一次会残留反斜杠，导致后续键名匹配失败。这里循环收敛到稳定：
 * 先把 \u0022 还原成 \" ，再把 \" 还原成 " ，最多迭代数轮防止异常输入空转。
 */
export function normalizeFlightFragment(fragment) {
  if (fragment === null || fragment === undefined) return '';
  let text = String(fragment);
  for (let round = 0; round < 8; round++) {
    const before = text;
    text = text.split('\\u0022').join('"');
    // 仅折叠「反斜杠 + 引号」，不动其它转义（\n、\t 等由 JSON.parse 处理）
    text = text.replace(/\\(?=["\\])/g, '');
    if (text === before) break;
  }
  return text;
}

/**
 * 扫描文本中所有「同时出现 offerId 与 hash」的花括号对象（最内层优先）。
 *
 * 返回原始文本片段数组（未做 JSON 解析）。调用方仍需 JSON.parse 并校验字段，
 * 因为包含 offerId 的外层容器对象也会被扫到 —— 那类对象解析后没有顶层
 * offerId/hash，会被调用方自然过滤掉。
 */
export function extractOfferObjects(text, maxObjectLength = 8000) {
  if (!text) return [];
  const normalized = normalizeFlightFragment(text);
  const found = [];
  const stack = [];
  let inString = false;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (inString) {
      if (ch === '"' && !isEscaped(normalized, i)) inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      stack.push(i);
    } else if (ch === '}' && stack.length > 0) {
      const start = stack.pop();
      const length = i - start + 1;
      if (length > maxObjectLength) continue;
      const slice = normalized.slice(start, i + 1);
      if (slice.includes('"offerId"') && slice.includes('"hash"')) {
        found.push(slice);
      }
    }
  }
  return found;
}

/**
 * 把 HTML 里所有 `self.__next_f.push([n,"..."])` 片段拼回完整 Flight 文本。
 *
 * 有 push 片段时：每段先 JSON.parse（自动去掉一层 JS 字符串转义）再拼接。
 * 没有 push 片段时：把整页 HTML 做同等的转义归一化，保持与旧实现兼容。
 */
export function concatFlightChunks(html) {
  const source = String(html ?? '');
  const chunks = [];
  const pushRegex = /self\.__next_f\.push\(\[\d+,\s*"(.*?)"\]\)/gs;
  let match;
  while ((match = pushRegex.exec(source)) !== null) {
    try {
      chunks.push(JSON.parse(`"${match[1]}"`));
    } catch {
      // 单个片段解析失败不影响其余片段
    }
  }
  if (chunks.length > 0) return chunks.join('');
  return normalizeFlightFragment(source);
}

/**
 * 从 Flight/HTML 文本里取出名为 key 的数组字面量原文。
 * 先做转义归一化，再用括号配平定位数组；找不到返回 null。
 */
export function extractJsonArray(text, key) {
  if (text === null || text === undefined || !key) return null;
  const source = normalizeFlightFragment(text);
  const needle = `"${key}"`;
  let idx = source.indexOf(needle);
  while (idx !== -1) {
    const bracketIndex = source.indexOf('[', idx + needle.length);
    // 键名与数组起点之间只允许出现冒号和空白，否则说明不是这个键
    if (bracketIndex !== -1 && /^[\s:]*$/.test(source.slice(idx + needle.length, bracketIndex))) {
      const end = findBalancedEnd(source, bracketIndex);
      if (end !== -1) return source.slice(bracketIndex, end + 1);
    }
    idx = source.indexOf(needle, idx + 1);
  }
  return null;
}
