import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Pion 构建配置。
 *
 * package.json 声明 "type": "module" 且 Electron ≥ 28 时，
 * electron-vite 自动将 main / preload 以 ESM（.mjs）输出，
 * 并为 ESM 产物注入 __dirname / require 垫片。
 *
 * externalizeDepsPlugin：主/预加载进程的依赖不打入 bundle，
 * 运行时直接从 node_modules 解析（pi SDK 的 RpcClient 依赖其包内文件布局，
 * 必须保持 external）。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: 'src/renderer/index.html' }
      }
    }
  }
})
