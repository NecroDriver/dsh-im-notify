window.__ModuleLoader__.load({
  id: "dsh-im-notify",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugin-src/client/index.js
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var React = __toESM(require("react"), 1);
var name = "dsh-im-notify-settings";
var inject = ["slots", "connection"];
var h = React.createElement;
function installStyles() {
  const STYLE_ID = "dsh-im-notify-styles";
  if (document.getElementById(STYLE_ID)) return () => {
  };
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    ".din-wrap{display:flex;flex-direction:column;gap:16px;max-width:560px;font-size:14px;line-height:1.6;}",
    ".din-card{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:10px;padding:16px 18px;}",
    ".din-cardTitle{font-weight:600;margin:0 0 8px;}",
    ".din-muted{opacity:.7;}",
    ".din-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}",
    ".din-row+.din-row{margin-top:10px;}",
    ".din-spacer{flex:1;}",
    ".din-btn{cursor:pointer;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:transparent;color:inherit;border-radius:7px;padding:6px 14px;font-size:13px;}",
    ".din-btn:hover:not(:disabled){border-color:currentColor;}",
    ".din-btn:disabled{opacity:.45;cursor:default;}",
    ".din-btnPrimary{border-color:transparent;background:#3370ff;color:#fff;}",
    ".din-btnPrimary:hover:not(:disabled){background:#2861dd;color:#fff;}",
    ".din-btnDanger:hover:not(:disabled){border-color:#e5484d;color:#e5484d;}",
    ".din-qrBox{display:flex;flex-direction:column;align-items:center;gap:12px;padding:8px 0;}",
    ".din-qrImg{width:240px;height:240px;border-radius:8px;background:#fff;padding:10px;box-sizing:border-box;}",
    ".din-qrImgExpired{filter:grayscale(1) blur(2px);opacity:.4;}",
    ".din-qrOverlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:600;}",
    ".din-qrFrame{position:relative;}",
    ".din-link{color:inherit;text-decoration:underline;text-underline-offset:3px;opacity:.85;}",
    ".din-list{display:flex;flex-direction:column;gap:8px;margin-top:8px;}",
    ".din-item{display:flex;align-items:center;gap:10px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:8px;padding:8px 12px;}",
    ".din-itemMain{display:flex;flex-direction:column;min-width:0;flex:1;}",
    ".din-itemTitle{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".din-badge{font-size:11px;border:1px solid color-mix(in srgb,currentColor 30%,transparent);border-radius:99px;padding:1px 8px;opacity:.8;}",
    ".din-badgeRun{border-color:#46a758;color:#46a758;opacity:1;}",
    ".din-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#46a758;margin-right:6px;}",
    ".din-dotOff{background:#f5a524;}",
    ".din-ok{color:#46a758;font-weight:600;}",
    ".din-err{color:#e5484d;}",
    ".din-code{font-family:ui-monospace,monospace;font-size:12px;opacity:.85;}"
  ].join("");
  document.head.appendChild(style);
  return () => style.remove();
}
function fmtDate(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}
function SetupView({ call, onConfigured, repairAppId = null, flowTitle = "\u626B\u7801\u63A5\u5165\u98DE\u4E66", onExit = null }) {
  const [flow, setFlow] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const begin = React.useCallback(async () => {
    setBusy(true);
    try {
      const result = await call("registration.begin", repairAppId ? { appId: repairAppId } : {});
      if (result?.ok) {
        const value = result.value ?? {};
        setFlow({ phase: "qr", ...value, remainingSeconds: value.remainingSeconds ?? 600 });
      } else {
        setFlow({ phase: "error", message: result?.error?.message ?? "\u65E0\u6CD5\u53D1\u8D77\u626B\u7801\u63A5\u5165\u3002" });
      }
    } catch (error) {
      setFlow({ phase: "error", message: error?.message ?? String(error) });
    } finally {
      setBusy(false);
    }
  }, [call, repairAppId]);
  React.useEffect(() => {
    if (flow?.phase !== "qr") return void 0;
    const { attemptId } = flow;
    let failures = 0;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const result = await call("registration.poll", { attemptId });
        failures = 0;
        if (stopped) return;
        if (result?.ok !== true) {
          setFlow({ phase: "error", message: result?.error?.message ?? "\u626B\u7801\u4F1A\u8BDD\u5DF2\u5931\u6548\u3002" });
          return;
        }
        const value = result.value ?? {};
        if (value.state === "succeeded") {
          setFlow({ phase: "succeeded", appIdMasked: value.appIdMasked });
          onConfigured?.();
          return;
        }
        if (value.state === "expired" || value.state === "cancelled") {
          setFlow({ phase: "error", message: value.state === "expired" ? "\u4E8C\u7EF4\u7801\u5DF2\u8FC7\u671F\uFF0C\u53EF\u91CD\u65B0\u53D1\u8D77\u3002" : "\u626B\u7801\u5DF2\u53D6\u6D88\u3002" });
          return;
        }
        if (value.state === "error") {
          setFlow({ phase: "error", message: value.error?.message ?? "\u6CE8\u518C\u8FC7\u7A0B\u51FA\u9519\u3002" });
          return;
        }
        setFlow((current) => current?.phase === "qr" && current.attemptId === attemptId ? {
          ...current,
          qrCodeDataUrl: value.qrCodeDataUrl ?? current.qrCodeDataUrl,
          verificationUrl: value.verificationUrl ?? current.verificationUrl,
          remainingSeconds: value.remainingSeconds ?? current.remainingSeconds
        } : current);
      } catch {
        failures += 1;
        if (failures >= 2 && !stopped) {
          setFlow({ phase: "error", message: "\u4E0E Host \u7684\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u8BF7\u91CD\u8BD5\u3002" });
        }
      }
    }, Math.max(1200, Math.min(5e3, flow.pollIntervalMs ?? 2e3)));
    return () => {
      stopped = true;
      clearInterval(timer);
      call("registration.cancel", { attemptId }).catch(() => {
      });
    };
  }, [flow?.phase, flow?.attemptId, call]);
  if (flow?.phase === "succeeded") {
    return h(
      "div",
      { className: "din-wrap" },
      h(
        "div",
        { className: "din-card" },
        h("p", { className: "din-cardTitle" }, h("span", { className: "din-ok" }, "\u2705 \u63A5\u5165\u5B8C\u6210")),
        h(
          "p",
          null,
          "\u98DE\u4E66\u81EA\u5EFA\u5E94\u7528\u5DF2\u521B\u5EFA\u5E76\u4FDD\u5B58\u51ED\u636E",
          flow.appIdMasked ? h("span", null, "\uFF08", h("span", { className: "din-code" }, flow.appIdMasked), "\uFF09") : null,
          "\u3002"
        ),
        h("p", { className: "din-muted" }, repairAppId ? "\u63D2\u4EF6\u5C06\u4F7F\u7528\u66F4\u65B0\u540E\u7684\u51ED\u636E\uFF1B\u82E5\u957F\u8FDE\u63A5\u672A\u81EA\u52A8\u6062\u590D\uFF0C\u8BF7\u91CD\u542F DeepSeek Harness\u3002" : "\u91CD\u542F DeepSeek Harness \u540E\u63D2\u4EF6\u5373\u53EF\u5F00\u59CB\u5DE5\u4F5C\uFF1B\u4E4B\u540E\u5728\u98DE\u4E66\u91CC\u5BF9\u673A\u5668\u4EBA\u53D1 ", repairAppId ? null : h("span", { className: "din-code" }, "/help"), repairAppId ? null : " \u67E5\u770B\u7528\u6CD5\u3002"),
        onExit ? h(
          "div",
          { className: "din-row" },
          h("span", { className: "din-spacer" }),
          h("button", { type: "button", className: "din-btn", onClick: onExit }, "\u8FD4\u56DE")
        ) : null
      )
    );
  }
  if (flow?.phase === "qr") {
    const expired = (flow.remainingSeconds ?? 0) <= 0;
    return h(
      "div",
      { className: "din-wrap" },
      h(
        "div",
        { className: "din-card" },
        h("p", { className: "din-cardTitle" }, flowTitle),
        h(
          "div",
          { className: "din-qrBox" },
          h(
            "div",
            { className: "din-qrFrame" },
            flow.qrCodeDataUrl ? h("img", {
              className: `din-qrImg${expired ? " din-qrImgExpired" : ""}`,
              src: flow.qrCodeDataUrl,
              alt: "\u98DE\u4E66\u5E94\u7528\u6388\u6743\u4E8C\u7EF4\u7801"
            }) : h("div", { className: "din-qrImg din-muted", role: "status" }, "\u4E8C\u7EF4\u7801\u751F\u6210\u4E2D\u2026"),
            expired ? h("div", { className: "din-qrOverlay", role: "status" }, "\u5DF2\u8FC7\u671F") : null
          ),
          h(
            "div",
            { className: "din-muted" },
            "\u7528\u98DE\u4E66\u626B\u7801\u5E76\u5728\u786E\u8BA4\u9875\u70B9\u51FB\u5141\u8BB8",
            expired ? null : `\uFF08\u5269\u4F59 ${Math.floor((flow.remainingSeconds ?? 0) / 60)}:${String((flow.remainingSeconds ?? 0) % 60).padStart(2, "0")}\uFF09`
          ),
          flow.verificationUrl ? h("a", { className: "din-link", href: flow.verificationUrl, target: "_blank", rel: "noopener noreferrer" }, "\u65E0\u6CD5\u626B\u7801\uFF1F\u6253\u5F00\u6388\u6743\u94FE\u63A5") : null
        ),
        h(
          "div",
          { className: "din-row" },
          onExit ? h("button", {
            type: "button",
            className: "din-btn",
            disabled: busy,
            onClick: () => {
              call("registration.cancel", { attemptId: flow.attemptId }).catch(() => {
              });
              onExit();
            }
          }, "\u2190 \u8FD4\u56DE") : h("span", { className: "din-spacer" }),
          h("button", {
            type: "button",
            className: "din-btn",
            disabled: busy,
            onClick: () => {
              call("registration.cancel", { attemptId: flow.attemptId }).catch(() => {
              });
              setFlow(null);
            }
          }, "\u53D6\u6D88")
        )
      )
    );
  }
  return h(
    "div",
    { className: "din-wrap" },
    flow?.phase === "error" ? h("div", { className: "din-card" }, h("p", { className: "din-err" }, `\u26A0\uFE0F ${flow.message}`)) : null,
    h(
      "div",
      { className: "din-card" },
      h("p", { className: "din-cardTitle" }, repairAppId ? flowTitle : "\u5C1A\u672A\u63A5\u5165"),
      h(
        "p",
        { className: "din-muted" },
        repairAppId ? "\u91CD\u65B0\u8D70\u4E00\u904D\u626B\u7801\u6388\u6743\uFF08\u8865\u6743\u9650 / \u66F4\u65B0\u51ED\u636E\uFF09\uFF0C\u5B8C\u6210\u540E\u81EA\u52A8\u4FDD\u5B58\u5230\u672C\u673A\u3002" : "\u626B\u7801\u5373\u53EF\u521B\u5EFA\u98DE\u4E66\u81EA\u5EFA\u5E94\u7528\u5E76\u81EA\u52A8\u914D\u7F6E\u6743\u9650\uFF08\u8BFB\u53D6\u6D88\u606F + \u53D1\u9001\u901A\u77E5\uFF09\u3002\u4EFB\u52A1\u5B8C\u6210\u65F6\u63A8\u9001\u5361\u7247\u5230\u98DE\u4E66\uFF0C\u5F15\u7528\u63A8\u9001\u53EF\u76F4\u63A5\u5411\u5BF9\u5E94\u4F1A\u8BDD\u4E0B\u8FBE\u6307\u4EE4\u3002"
      ),
      h(
        "div",
        { className: "din-row" },
        onExit ? h("button", { type: "button", className: "din-btn", disabled: busy, onClick: onExit }, "\u2190 \u8FD4\u56DE") : null,
        h("button", {
          type: "button",
          className: "din-btn din-btnPrimary",
          disabled: busy,
          onClick: begin
        }, busy ? "\u6B63\u5728\u53D1\u8D77\u2026" : repairAppId ? "\u91CD\u65B0\u626B\u7801\u6388\u6743" : "\u626B\u7801\u63A5\u5165\u98DE\u4E66")
      )
    )
  );
}
function ConfiguredView({ call, status, setStatus, onCredentialsFlow }) {
  const [busyKey, setBusyKey] = React.useState(null);
  const run = async (key, method, payload) => {
    setBusyKey(key);
    try {
      const result = await call(method, payload);
      if (result?.ok) setStatus(result.value);
    } finally {
      setBusyKey(null);
    }
  };
  const conn = status.connection ?? {};
  const connState = conn.state ?? (status.botReady ? "online" : "offline");
  const connLabel = connState === "online" ? "\u957F\u8FDE\u63A5\u6B63\u5E38" : connState === "connecting" ? "\u8FDE\u63A5\u4E2D\u2026" : connState === "retrying" ? `\u91CD\u8BD5\u4E2D\uFF08\u7B2C ${conn.attempts ?? "?"} \u6B21\uFF09\u2026` : connState === "failed" ? "\u8FDE\u63A5\u5931\u8D25" : "\u672A\u8FDE\u63A5\uFF08\u91CD\u542F Host \u540E\u751F\u6548\uFF09";
  return h(
    "div",
    { className: "din-wrap" },
    h(
      "div",
      { className: "din-card" },
      h("p", { className: "din-cardTitle" }, "\u98DE\u4E66\u901A\u77E5"),
      h(
        "div",
        { className: "din-row" },
        h(
          "span",
          null,
          h("span", { className: connState === "online" ? "din-dot" : "din-dot din-dotOff" }),
          connLabel
        ),
        h("span", { className: "din-badge" }, `\u5E94\u7528 ${status.appIdMasked ?? "-"}`),
        status.domain === "lark" ? h("span", { className: "din-badge" }, "Lark \u56FD\u9645\u7248") : null
      ),
      connState === "failed" || connState === "retrying" ? h(
        "p",
        { className: "din-err", style: { marginTop: 8 } },
        `\u26A0\uFE0F ${conn.error ?? "\u98DE\u4E66\u957F\u8FDE\u63A5\u672A\u5EFA\u7ACB"}`,
        h(
          "div",
          { className: "din-row", style: { marginTop: 6 } },
          h("button", {
            type: "button",
            className: "din-btn",
            disabled: busyKey === "retry",
            onClick: () => run("retry", "connection.retry", {})
          }, "\u7ACB\u5373\u91CD\u8BD5\u8FDE\u63A5")
        )
      ) : null,
      h(
        "div",
        { className: "din-row din-muted" },
        h("span", null, `\u5173\u6CE8 ${status.watchCount} \u4E2A\u4F1A\u8BDD \xB7 \u56DE\u7A0B\u6620\u5C04 ${status.mappingCount} \u6761`)
      )
    ),
    h(
      "div",
      { className: "din-card" },
      h(
        "div",
        { className: "din-row" },
        h("p", { className: "din-cardTitle", style: { margin: 0, flex: 1 } }, "\u5173\u6CE8\u7684\u4F1A\u8BDD"),
        status.watchCount > 0 ? h("button", {
          type: "button",
          className: "din-btn din-btnDanger",
          disabled: busyKey === "clear",
          onClick: () => run("clear", "watch.clear", {})
        }, "\u6E05\u7A7A") : null
      ),
      status.watches.length === 0 ? h("p", { className: "din-muted" }, "\u8FD8\u6CA1\u6709\u5173\u6CE8\u4EFB\u4F55\u4F1A\u8BDD\u3002\u5728\u98DE\u4E66\u91CC\u53D1 /sessions \u67E5\u770B\u5217\u8868\uFF0C/watch \u5E8F\u53F7 \u5173\u6CE8\u3002") : h("div", { className: "din-list" }, status.watches.map((watch) => h(
        "div",
        { key: `${watch.chatId}/${watch.sessionId}`, className: "din-item" },
        h(
          "div",
          { className: "din-itemMain" },
          h("span", { className: "din-itemTitle" }, watch.title ?? "\uFF08\u65E0\u6807\u9898\u4F1A\u8BDD\uFF09"),
          h(
            "span",
            { className: "din-muted din-code" },
            `${watch.sessionId.slice(0, 10)}\u2026 \xB7 \u6DFB\u52A0\u4E8E ${fmtDate(watch.addedAt)}`
          )
        ),
        watch.running ? h("span", { className: "din-badge din-badgeRun" }, "\u{1F3C3} \u8FD0\u884C\u4E2D") : null,
        h("button", {
          type: "button",
          className: "din-btn",
          disabled: busyKey === `rm:${watch.sessionId}`,
          onClick: () => run(`rm:${watch.sessionId}`, "watch.remove", { chatId: watch.chatId, sessionId: watch.sessionId })
        }, "\u79FB\u9664")
      ))),
      h(
        "div",
        { className: "din-row", style: { marginTop: 16 } },
        h("button", {
          type: "button",
          className: "din-btn",
          onClick: () => onCredentialsFlow?.("repair")
        }, "\u91CD\u65B0\u6388\u6743"),
        h("button", {
          type: "button",
          className: "din-btn",
          onClick: () => onCredentialsFlow?.("replace")
        }, "\u66F4\u6362\u65B0\u5E94\u7528"),
        h("span", { className: "din-muted" }, "\u66F4\u6362\u51ED\u636E\u65E0\u9700\u547D\u4EE4\u884C")
      )
    )
  );
}
function NotifyPanel({ call }) {
  const [status, setStatus] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [flowMode, setFlowMode] = React.useState(null);
  React.useEffect(() => {
    let disposed = false;
    call("status", {}).then((result) => {
      if (disposed) return;
      if (result?.ok) setStatus(result.value);
      else setError(result?.error?.message ?? "\u8BFB\u53D6\u72B6\u6001\u5931\u8D25\u3002");
    }).catch((cause) => {
      if (!disposed) setError(cause?.message ?? String(cause));
    });
    return () => {
      disposed = true;
    };
  }, [call]);
  if (error) {
    return h(
      "div",
      { className: "din-wrap" },
      h(
        "div",
        { className: "din-card" },
        h("p", { className: "din-err" }, `\u26A0\uFE0F ${error}`),
        h("p", { className: "din-muted" }, "\u8BF7\u786E\u8BA4 dsh-im-notify \u63D2\u4EF6\u5DF2\u542F\u7528\u5E76\u968F Host \u4E00\u8D77\u91CD\u542F\u3002")
      )
    );
  }
  if (!status) {
    return h("div", { className: "din-wrap" }, h("div", { className: "din-card din-muted" }, "\u52A0\u8F7D\u4E2D\u2026"));
  }
  if (status.configured && flowMode) {
    return h(CredentialsFlow, {
      call,
      status,
      mode: flowMode,
      onExit: () => setFlowMode(null),
      onConfigured: () => {
        setFlowMode(null);
        call("status", {}).then((r) => {
          if (r?.ok) setStatus(r.value);
        }).catch(() => {
        });
      }
    });
  }
  return status.configured ? h(ConfiguredView, {
    call,
    status,
    setStatus,
    onCredentialsFlow: (mode) => setFlowMode(mode)
    // 'repair' | 'replace'
  }) : h(SetupView, {
    call,
    onConfigured: () => {
      call("status", {}).then((r) => {
        if (r?.ok) setStatus(r.value);
      }).catch(() => {
      });
    }
  });
}
function CredentialsFlow({ call, status, mode, onExit, onConfigured }) {
  return h(SetupView, {
    call,
    repairAppId: mode === "repair" ? status.appId : null,
    flowTitle: mode === "repair" ? "\u91CD\u65B0\u6388\u6743\u5F53\u524D\u5E94\u7528" : "\u66F4\u6362\u65B0\u5E94\u7528",
    onExit,
    onConfigured
  });
}
function apply(ctx) {
  const call = (method, payload, signal) => ctx.connection.rpc.call("/api", "dsh-im-notify", { method, payload }, signal);
  ctx.effect(() => installStyles(), "dsh-im-notify: settings styles");
  ctx.effect(() => ctx.slots.inject("settings.section", () => {
    const unregister = ctx.slots.register({
      name: "settings.section",
      id: "dsh-im-notify",
      order: 22,
      label: "IM \u901A\u77E5"
    }, () => h(NotifyPanel, { call }));
    return () => unregister();
  }), "dsh-im-notify: settings panel");
}

    return module.exports;
  }
});
