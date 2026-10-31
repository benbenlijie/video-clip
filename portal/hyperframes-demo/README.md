# Wayne HyperFrames 动效样例

使用项目隔离的 HyperFrames 0.8.221 与 GSAP 3.14.2，输出 ProRes 4444 MOV 透明动效层，供 FFmpeg 叠加到实际视频。样例使用产品设计中的深色底、薄荷绿强调色和橘色结构线。

```bash
npm run check
npm run render
```

HyperFrames `check` 会运行时间线、布局和 motion 检查；Render 使用本机 Chrome 与 FFmpeg。正式门户的动态 HTML 由 `server/hyperframes-overlay.mjs` 根据已验证的剪辑事件生成；CLI 输出先验证 ProRes 4444 alpha plane，再交给 FFmpeg 主片与 Shorts 合成。
