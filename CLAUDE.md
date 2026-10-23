# 世界华人腕力协会比赛系统（armwrestle-system）

## 项目定位

单机、离线优先的腕力比赛编排与记分系统。正式使用场景：**一台电脑、Chrome/Edge、3 个级别同时进行，每级别 1 桌**。

- 线上地址：https://darkheaven1419-debug.github.io/armwrestle-system/
- GitHub：https://github.com/darkheaven1419-debug/armwrestle-system
- 本地路径：`C:\Users\11468\Desktop\armwrestle-system`
- 部署：GitHub Pages，源为 `main` 分支根目录 `/`（legacy 分支发布，无自定义 Actions）

## 技术栈

- 原生 HTML + CSS + ES6 JavaScript（IIFE 挂 `window.WACAA`），无框架、无构建、无 npm 运行依赖
- PWA：`manifest.webmanifest` + `sw.js`
- 拼音：`vendor/pinyin-pro.js`（本地文件）
- 数据：`localStorage`，无后端、无网络请求、无多设备同步
- 测试：Node 22 自带 `node --test`，不安装任何 npm 包

## 本地运行

```powershell
cd C:\Users\11468\Desktop\armwrestle-system
python -m http.server 8000
```

打开 `http://localhost:8000/`。Service Worker 需要 `localhost` 或 HTTPS，不能直接用 `file://` 验证缓存行为。

## 文件结构

| 文件 | 职责 |
|------|------|
| `index.html` | 入口，按依赖顺序加载脚本 |
| `version.js` | **版本号唯一来源**（页面与 Service Worker 共用） |
| `utils.js` | uid、拼音、转义、DOM 构造等工具 |
| `state.js` | 状态、localStorage、备份、导入校验、选手/级别工厂 |
| `bracket.js` | 双败淘汰引擎 + 纯查询/预测函数（不碰 DOM） |
| `ui.js` | 页面渲染与交互 |
| `board.js` | 比赛进行中的三桌看板和名次抽屉（只读渲染） |
| `app.js` | 启动、旧数据修复、自动备份 |
| `sw.js` | Service Worker（版本化缓存、更新提示） |
| `style.css` | 全站样式，颜色集中在 `:root` 变量 |
| `tests/` | `node --test` 测试与存储压测脚本 |

## 数据存储（禁止随意改动）

- 主数据键：`wacaa_armwrestle_v1`
- 备份键：`wacaa_armwrestle_backup`（最近 3 份）
- 不得修改键名和顶层数据结构。若某项必须调整，**先告知用户**，并写兼容迁移，保证旧数据和旧版导出的 JSON 仍能加载/导入。
- 导入必须经过 `W.normalizeState` 归一化；解析失败给中文报错，不能让页面崩溃。

## 硬性规则

1. 只在一台电脑上用：不做多设备同步，不引入后端。
2. 保持纯静态：不引入框架、构建工具、npm 依赖、外部 CDN 或网络字体，必须能离线使用。
3. 在现有代码上改，不推倒重写；**不要重写 `bracket.js` 的双败引擎**。
4. 现有功能一个都不能少，只能改位置和呈现；删功能必须先问用户。
5. 所有改动在 `redesign` 分支进行。**不要动 `main`**；合并/推送 `main` 必须等用户明确同意。分支可以 push 备份。
6. 每个步骤单独 commit，提交信息用中文。
7. 界面文字全部中文；术语统一：赛事 / 级别 / 桌 / 胜者组 / 败者组 / 选手 / 撤回。
8. 有拿不准的地方集中问，一次最多 3 个问题。
9. 新增代码不要引入渲染副作用；现有 `renderLevel` 等函数的副作用本次不重构。
10. 记录一场结果最多 2 次点击；防误触用“撤回条”，不用二次确认。撤回条保留到该级别下一场结算之前。

## 界面方向（第 2 阶段）

- 浅色、干净、正式赛事系统风格；白/极浅灰底 + 深蓝主色
- “正在比赛”和“下一组”用两个明显不同的强调色
- 配色只定义在 `style.css` 的 `:root` 变量里
- 1920×1080 与 1366×768 下，比赛主界面一屏看完，不滚动
- 选手名字要大到 2–3 米外可读

## 测试

```bash
node --test tests/engine.test.js tests/predict.test.js tests/storage.test.js
```

- 引擎/状态测试通过 `tests/harness.js` 在 `node:vm` 中加载 `utils.js`、`state.js`、`bracket.js`
- 固定随机种子，保证可复现
- 存储压测模拟“3 个级别 × 32 人”和“3 个级别 × 64 人”完整打完，报告实际占用

## 分支与回滚

- 回滚点：tag `before-redesign`（指向 redesign 开始前的 `main`）
- 工作分支：`redesign`
- 未经用户同意，不合并、不推送 `main`
