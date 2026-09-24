# 主题系统

界面主题由**两个正交维度**组合而成,由 `useTheme()` 同时写入 `<html>`:

| 属性 | 取值 | 含义 |
|---|---|---|
| `data-theme` | `steel` / `graphite` / `forest` / `violet` / `amber` | 色板 |
| `data-mode` | `light` / `dark` | 明暗(`mode=auto` 时由宿主/系统解析后写入) |

5 套色板 × 2 种明暗 = **10 种外观**。

## 当前色板

| id | 名称 | 强调色 | 底色倾向 |
|---|---|---|---|
| `steel` | 钢蓝 | 冷蓝 | 冷灰蓝(Godot 编辑器质感,默认) |
| `graphite` | 石墨 | 中性灰 | 无彩中性 |
| `forest` | 森野 | 绿 | 极淡冷绿 |
| `violet` | 紫罗兰 | 紫 | 冷紫 |
| `amber` | 暖阳 | 暖橙 | 暖灰 |

## 分工与设计约束

CSS 结构刻意避免 10 份完整令牌表的重复:

```
:root                                 结构令牌 + 浅色语义色/阴影 + 默认色板(钢蓝·浅色)
:root[data-mode='light'|'dark']       语义色、阴影、color-scheme
:root[data-theme='X'][data-mode='Y']  该组合下的 14 个色彩令牌
```

**刻意不随色板变化**的两组令牌(由 `src/__tests__/theme.test.mjs` 强制):

- **语义色** `--danger` / `--ok` / `--warn` / `--gold` —— 红就是危险、绿就是成功,
  换色板不该改变含义;
- **头像渐变** `--grad-a..d` —— 按项目名哈希取色,是「个体识别」而不是装饰。
  换成同色系灰阶会让项目列表失去区分度。

每个色板只需定义这 14 个令牌:
`--brand --brand-strong --brand-deep --brand-weak --brand-grad`
`--bg --surface --surface-2 --surface-3`
`--border --border-strong`
`--text --text-2 --text-3`

## 新增一套色板的步骤

1. 在 `src/types/godot.ts` 的 `ThemeId` 联合类型里加上新 id;
2. 在 `src/composables/useTheme.ts` 的 `THEMES` 里追加一项(含 `swatch` 与 `swatchDark` 两组预览色);
3. 在 `src/main.css` 里补两个块:
   `:root[data-theme='新id'][data-mode='light']` 与 `...[data-mode='dark']`,
   各写全上面 14 个令牌;
4. 跑 `npm run test:theme`。

第 4 步会校验:令牌是否写全、值是否可解析、语义色/头像渐变有没有被误改,
以及 8 组配色对的 WCAG 对比度是否达标 —— 这四类问题在界面上通常只表现为
「某个角落颜色怪怪的」,靠肉眼穷举 10 种组合不现实。

## 对比度门槛与实测

`npm run test:theme` 会对每个组合断言:

| 配色对 | 门槛 | 实测最低 | 出现在 |
|---|---|---|---|
| `--text` / `--surface` | ≥ 7.0 | 13.72 | graphite/dark |
| `--text` / `--bg` | ≥ 7.0 | 12.86 | steel/light |
| `--text-2` / `--surface` | ≥ 4.5 | 6.84 | steel/light |
| `--text-2` / `--bg` | ≥ 4.5 | 6.03 | steel/light |
| `--text-3` / `--surface` | ≥ 3.0 | 3.13 | steel/light |
| `--brand` / `--surface` | ≥ 3.0 | 3.64 | steel/light |
| `--border` / `--surface` | ≥ 1.15 | 1.24 | amber/dark |
| `--surface` / `--bg` | ≥ 1.05 | 1.08 | amber/dark |

**已知弱点**:主要按钮(`.btn.primary`)是白字压在 `--brand-grad` 渐变上。
渐变较亮一端的白字对比度只有 **2.82**(steel/light)、最低 2.65(amber/dark),
低于 WCAG AA 对正文的 3.0 —— 文字实际落在渐变中段(约 3.7),观感可读,
但这是个**沿用自旧版默认色板的既有取舍**,不是本次引入的。
若要严格达标,只需把各色板 `--brand-grad` 的亮端压深约 8%。

## 其它

- **持久化**:`GodotSettings.theme` 与 `themeMode`,切换时写入。
- **避免首帧闪色**:`useTheme()` 不依赖组件生命周期,因此在 `src/main.ts` 里
  `mount()` **之前**调用(不是放在 `App.vue` 的 `onMounted`)。
- **跟随宿主**:`auto` 优先读 `window.ztools.isDarkColors()`,拿不到时退回
  `matchMedia('(prefers-color-scheme: dark)')`,并监听其 `change` 事件 ——
  系统在运行中切换深浅时无需重开插件。
- **深色下的原生控件**:`data-mode='dark'` 同时设置 `color-scheme: dark`,
  否则下拉框、滚动条等原生控件仍会以浅色渲染。
- **入口**:顶栏右侧的调色板按钮(浮层)与 设置 → 外观主题(内联面板),
  两者共用 `ThemeSwitcher.vue` 的同一份面板标记。
