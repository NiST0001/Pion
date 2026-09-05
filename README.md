# Pion

Pion 是 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的桌面应用。

## 使用

```bash
npm install
./dev.sh
```

要求 Node ≥ 22.12；模型凭证读取 `~/.pi/agent/auth.json`。

## 开发

```bash
npm run typecheck   # 类型检查
npm test            # 单元与组件测试
npm run test:e2e    # Electron 端到端测试
```

详见 [docs/development.md](docs/development.md)。

## License

MIT
