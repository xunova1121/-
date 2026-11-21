/**
 * 技能要运行什么、要装哪些依赖：从技能文件（requirements.txt、package.json、pyproject.toml）和说明里写的
 * “pip install …”“npm install …”读出来。服务器的技能运行器（server/skillRunner.mjs）照这个装依赖。
 * 只认包名和版本号这种简单写法；带网址、本地路径、奇怪参数的一律不装（不把说明里的任意命令当安装命令执行）。
 */
export const PY_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?(?:(?:===?|!=|~=|<=?|>=?)[A-Za-z0-9.*+!_-]+(?:,(?:===?|!=|~=|<=?|>=?)[A-Za-z0-9.*+!_-]+)*)?$/;
export const NPM_SPEC = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9.^~<>=*_-]+)?$/i;
const PY_INSTALL = /^(?:\$\s*)?(?:sudo\s+)?(?:pip3?|python3?\s+-m\s+pip|uv\s+pip|pipx)\s+install\s+(.+)$/;
const NPM_INSTALL = /^(?:\$\s*)?(?:npm\s+(?:install|i|add)|pnpm\s+add|yarn\s+add)\s+(.+)$/;
/** 说明里的命令行以这些开头：要在命令行里跑东西 */
const RUNS = /^(?:\$\s*)?(?:python3?|node|npx|uv|uvx|pipx|bash|sh)\s/;

const tokens = (rest) => rest.replace(/#.*$/, '').trim().split(/\s+/).filter(Boolean);
/** 一条安装命令里的包名（遇到网址、路径、-r 文件等不认识的写法就整条不要） */
function packagesOf(rest, spec) {
  const out = [];
  for (const t of tokens(rest)) {
    if (/^(-U|--upgrade|--user|-q|--quiet|-g|--global|--save(?:-dev)?|-D|--no-cache-dir)$/.test(t)) continue;
    if (t.startsWith('-') || !spec.test(t.replace(/^["']|["']$/g, ''))) return [];
    out.push(t.replace(/^["']|["']$/g, ''));
  }
  return out;
}

/** 说明正文里代码块和行内代码里的命令行 */
function commandLines(body) {
  const lines = [];
  for (const m of String(body ?? '').matchAll(/```[^\n]*\n([\s\S]*?)```/g)) lines.push(...m[1].split('\n'));
  for (const m of String(body ?? '').matchAll(/`([^`\n]{3,200})`/g)) lines.push(m[1]);
  return lines.map((l) => l.trim()).filter(Boolean);
}

/**
 * @param {{ body?: string, files?: object }} pack
 * @returns {{ python: string[], pythonRequirements: boolean, pythonProject: boolean, node: string[], nodePackage: boolean }}
 */
export function skillDeps(pack) {
  const files = pack?.files ?? {};
  const python = new Set();
  const node = new Set();
  for (const line of commandLines(pack?.body)) {
    const py = line.match(PY_INSTALL);
    if (py) for (const p of packagesOf(py[1], PY_SPEC)) python.add(p);
    const js = line.match(NPM_INSTALL);
    if (js) for (const p of packagesOf(js[1], NPM_SPEC)) node.add(p);
  }
  const textOf = (k) => (typeof files[k] === 'string' ? files[k] : '');
  return {
    python: [...python].slice(0, 40),
    pythonRequirements: typeof files['requirements.txt'] === 'string',
    pythonProject: Boolean(textOf('pyproject.toml') || textOf('setup.py')),
    node: [...node].slice(0, 40),
    nodePackage: /"dependencies"\s*:/.test(textOf('package.json'))
  };
}

/** 有没有要装的依赖 */
export const hasDeps = (d) => Boolean(d.python.length || d.pythonRequirements || d.pythonProject || d.node.length || d.nodePackage);

/** 这个技能要不要在运行器里跑东西（带脚本、要装依赖、说明里写着要运行命令） */
export function needsRunner(pack) {
  if (Object.keys(pack?.files ?? {}).some((p) => /\.(py|sh|js|mjs|cjs|ts)$/i.test(p))) return true;
  if (hasDeps(skillDeps(pack)) || /```(?:bash|sh|shell|console|zsh)\b/i.test(String(pack?.body ?? ''))) return true;
  return commandLines(pack?.body).some((l) => RUNS.test(l));
}

/** 依赖的“指纹”：变了才重新装 */
export function depsKey(d) {
  return JSON.stringify([d.python, d.pythonRequirements, d.pythonProject, d.node, d.nodePackage]);
}
