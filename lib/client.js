window.__ModuleLoader__.load({
  id: "dsh-video-storyboard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    function SettingsTab() {
      const injected = globalThis.__DSH_VIDEO_STORYBOARD_SETTINGS__;
      const url = injected && typeof injected.url === "string" ? injected.url : "";
      const intro = React.createElement("p", {
        style: { margin: "0 0 12px", color: "var(--dsw-alias-label-tertiary, #68707d)", fontSize: "13px", lineHeight: "20px" }
      }, "设置页由插件本地服务提供；密钥只写不读，依赖检查不自动安装。");
      if (!url) {
        return React.createElement("div", null, intro, React.createElement("p", {
          style: { margin: 0, color: "var(--dsw-alias-label-tertiary, #68707d)", fontSize: "13px" }
        }, "设置页尚未注入，请重启 DSH 或在插件日志里查看设置路由错误。"));
      }
      return React.createElement("div", { style: { display: "flex", flexDirection: "column", width: "100%" } },
        intro,
        React.createElement("iframe", {
          src: url,
          title: "视频分镜设置",
          style: { width: "100%", height: "calc(100vh - 210px)", minHeight: "560px", border: "0", borderRadius: "12px", background: "transparent" }
        })
      );
    }
    function apply(ctx) {
      ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
        name: "settings.plugins.tab",
        id: "video-storyboard",
        order: 20,
        label: () => "视频分镜"
      }, SettingsTab));
    }
    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
