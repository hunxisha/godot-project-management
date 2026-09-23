<script setup lang="ts">
import { onMounted, ref } from 'vue'
import TabBar from './components/TabBar.vue'
import Dashboard from './views/Dashboard.vue'
import ProjectsView from './views/ProjectsView.vue'
import VersionsView from './views/VersionsView.vue'
import MarketplaceView from './views/MarketplaceView.vue'
import SettingsView from './views/SettingsView.vue'

const tab = ref('dashboard')
/** addProject 功能(拖入)带入的文件路径 */
const enterPayload = ref<string[] | null>(null)

onMounted(() => {
  document.documentElement.dataset.theme = window.ztools.isDarkColors() ? 'dark' : 'light'
  window.ztools.setExpendHeight(600)
  window.ztools.onPluginEnter(({ code, payload }) => {
    if (code === 'projects') tab.value = 'projects'
    else if (code === 'versions') tab.value = 'versions'
    else if (code === 'plugins') tab.value = 'marketplace'
    else if (code === 'addProject') {
      tab.value = 'projects'
      enterPayload.value = payload as string[]
    } else tab.value = 'dashboard'
  })
})
</script>

<template>
  <div class="app">
    <TabBar v-model="tab" />
    <main class="content">
      <Dashboard v-if="tab === 'dashboard'" @navigate="tab = $event" />
      <ProjectsView v-else-if="tab === 'projects'" :enter-payload="enterPayload" @consumed="enterPayload = null" />
      <VersionsView v-else-if="tab === 'versions'" />
      <MarketplaceView v-else-if="tab === 'marketplace'" @navigate="tab = $event" />
      <SettingsView v-else />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.content {
  flex: 1;
  overflow-y: auto;
}
</style>
