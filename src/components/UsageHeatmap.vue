<script setup lang="ts">
// 概览页「引擎使用」热力图:GitHub 贡献图风格,按日着色(周一起始,近 N 周)。
// 纯展示组件:数据(days/minutes 与 sessions)由 Dashboard 读取 godot/usage/* 文档后传入,
// 网格与色阶的纯函数在 utils/usage.ts。
import { computed, ref } from 'vue'
import type { UsageSession } from '../types/godot'
import { buildHeatmapGrid, fmtDayLabel, fmtMinutes, type HeatCell } from '../utils/usage'

const props = defineProps<{
  /** dayKey('YYYY-MM-DD') → 当日使用分钟 */
  days: Record<string, number>
  /** 启动会话(tooltip 里展示当天打开过的项目) */
  sessions?: UsageSession[]
  /** 周数(默认 26 ≈ 半年) */
  weeks?: number
}>()

const columns = computed(() => buildHeatmapGrid(props.days, { weeks: props.weeks ?? 26 }))

/** 行标签:周一/三/五 有字,其余留空占位(与 7 行格子对齐) */
const weekdayLabels = ['一', '', '三', '', '五', '', '']

interface HoverState {
  cell: HeatCell
  x: number
  y: number
  projects: string
}
const hover = ref<HoverState | null>(null)

function onEnter(cell: HeatCell, e: MouseEvent) {
  if (cell.future) {
    hover.value = null
    return
  }
  const names = [...new Set((props.sessions ?? []).filter((s) => s && s.day === cell.key && s.projectName).map((s) => s.projectName))]
  const shown = names.slice(0, 3).join('、')
  hover.value = {
    cell,
    x: e.clientX + 12,
    y: e.clientY + 14,
    projects: shown + (names.length > 3 ? ` 等 ${names.length} 个` : '')
  }
}
</script>

<template>
  <div class="hm" @mouseleave="hover = null">
    <div class="hm-scroll">
      <div class="hm-months">
        <span v-for="(col, i) in columns" :key="i" class="hm-month">{{ col.monthLabel ?? '' }}</span>
      </div>
      <div class="hm-body">
        <div class="hm-weekdays">
          <span v-for="(w, i) in weekdayLabels" :key="i" class="hm-wd">{{ w }}</span>
        </div>
        <div class="hm-grid">
          <div v-for="(col, i) in columns" :key="i" class="hm-col">
            <span
              v-for="cell in col.cells"
              :key="cell.key"
              class="hm-cell"
              :class="[`lv-${cell.level}`, { future: cell.future }]"
              @mouseenter="onEnter(cell, $event)"
            />
          </div>
        </div>
      </div>
    </div>
    <div class="hm-legend">
      <span class="hm-legend-label">少</span>
      <span v-for="l in 5" :key="l" class="hm-cell" :class="`lv-${l - 1}`" />
      <span class="hm-legend-label">多</span>
    </div>

    <div v-if="hover" class="hm-tip" :style="{ left: hover.x + 'px', top: hover.y + 'px' }">
      <div class="hm-tip-main">{{ fmtDayLabel(hover.cell.date) }} · {{ fmtMinutes(hover.cell.minutes) }}</div>
      <div v-if="hover.projects" class="hm-tip-sub">打开过:{{ hover.projects }}</div>
    </div>
  </div>
</template>

<style scoped>
.hm {
  position: relative;
}

.hm-scroll {
  overflow-x: auto;
  padding-bottom: 2px;
}

/* 月份刻度:与格子列同宽,标签允许溢出绘制 */
.hm-months {
  display: flex;
  gap: 3px;
  margin-left: 26px;
  margin-bottom: 3px;
  height: 13px;
}

.hm-month {
  width: 11px;
  overflow: visible;
  white-space: nowrap;
  font-size: 10px;
  color: var(--text-3);
}

.hm-body {
  display: flex;
  gap: 4px;
}

/* 行标签列:7 行,行高与格子+gap 对齐 */
.hm-weekdays {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.hm-wd {
  width: 22px;
  height: 11px;
  line-height: 11px;
  font-size: 10px;
  color: var(--text-3);
}

.hm-grid {
  display: flex;
  gap: 3px;
}

.hm-col {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.hm-cell {
  width: 11px;
  height: 11px;
  border-radius: 3px;
  background: var(--surface-3);
  flex-shrink: 0;
}

.hm-cell.future {
  visibility: hidden;
}

/* 色阶:品牌色混入底色,随 5 套色板/明暗主题自动适配(color-mix 先例:TasksView/chrome 层) */
.hm-cell.lv-1 { background: color-mix(in srgb, var(--brand) 25%, var(--surface-3)); }
.hm-cell.lv-2 { background: color-mix(in srgb, var(--brand) 50%, var(--surface-3)); }
.hm-cell.lv-3 { background: color-mix(in srgb, var(--brand) 75%, var(--surface-3)); }
.hm-cell.lv-4 { background: var(--brand); }

.hm-cell:not(.future):hover {
  box-shadow: 0 0 0 1.5px var(--text-3);
}

.hm-legend {
  display: flex;
  align-items: center;
  gap: 3px;
  justify-content: flex-end;
  margin-top: 8px;
}

.hm-legend-label {
  font-size: 10px;
  color: var(--text-3);
  margin: 0 3px;
}

/* 悬停浮层:跟随指针的 fixed 定位,不参与布局 */
.hm-tip {
  position: fixed;
  z-index: 1000;
  pointer-events: none;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-overlay);
  padding: 6px 10px;
  max-width: 320px;
}

.hm-tip-main {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.hm-tip-sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}
</style>
