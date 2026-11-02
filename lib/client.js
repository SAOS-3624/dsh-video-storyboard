window.__ModuleLoader__.load({
  id: "dsh-video-storyboard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useState } = React;

    const CSS = [
      '[data-dsh-vs]{color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:20px}',
      '[data-dsh-vs] *{box-sizing:border-box}',
      '[data-dsh-vs] .dsh-vs-section{padding:20px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
      '[data-dsh-vs] .dsh-vs-section:first-of-type{padding-top:2px;border-top:0}',
      '[data-dsh-vs] .dsh-vs-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px}',
      '[data-dsh-vs] .dsh-vs-section-title{margin:0;font-size:14px;line-height:22px;font-weight:600}',
      '[data-dsh-vs] .dsh-vs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 18px}',
      '[data-dsh-vs] .dsh-vs-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '[data-dsh-vs] .dsh-vs-span-2{grid-column:1/-1}',
      '[data-dsh-vs] .dsh-vs-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#5c6370)}',
      '[data-dsh-vs] .dsh-vs-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919e)}',
      '[data-dsh-vs] .dsh-vs-input{width:100%;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;outline:none}',
      '[data-dsh-vs] .dsh-vs-input::placeholder{color:var(--dsw-alias-label-tertiary,#a0a6b0)}',
      '[data-dsh-vs] .dsh-vs-input:focus{border-color:var(--dsw-alias-brand-primary,#4f7cff);box-shadow:0 0 0 3px rgba(79,124,255,.14)}',
      '[data-dsh-vs] .dsh-vs-inline{display:flex;align-items:center;gap:10px;min-height:34px}',
      '[data-dsh-vs] .dsh-vs-toggle{position:relative;width:36px;height:20px;flex:none;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-bg-skeleton,#d9dde4);cursor:pointer;transition:background .15s ease}',
      '[data-dsh-vs] .dsh-vs-toggle.is-on{background:var(--dsw-alias-brand-primary,#4f7cff)}',
      '[data-dsh-vs] .dsh-vs-toggle-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.18);transition:transform .15s ease}',
      '[data-dsh-vs] .dsh-vs-toggle.is-on .dsh-vs-toggle-knob{transform:translateX(16px)}',
      '[data-dsh-vs] .dsh-vs-check{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#5c6370)}',
      '[data-dsh-vs] .dsh-vs-check input{accent-color:var(--dsw-alias-brand-primary,#4f7cff)}',
      '[data-dsh-vs] .dsh-vs-effective{margin:10px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919e);overflow-wrap:anywhere}',
      '[data-dsh-vs] .dsh-vs-deps{display:flex;flex-direction:column}',
      '[data-dsh-vs] .dsh-vs-dep{display:flex;align-items:center;gap:10px;min-height:46px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}',
      '[data-dsh-vs] .dsh-vs-dep:first-child{border-top:0;padding-top:2px}',
      '[data-dsh-vs] .dsh-vs-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-state-success-primary,#31a36b)}',
      '[data-dsh-vs] .dsh-vs-dot.is-bad{background:var(--dsw-alias-state-error-primary,#e5484d)}',
      '[data-dsh-vs] .dsh-vs-dot.is-warn{background:var(--dsw-alias-state-warn-primary,#d89614)}',
      '[data-dsh-vs] .dsh-vs-dep-main{min-width:0;flex:1}',
      '[data-dsh-vs] .dsh-vs-dep-name{font-size:13px;line-height:18px}',
      '[data-dsh-vs] .dsh-vs-dep-detail{margin-top:1px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a919e);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '[data-dsh-vs] .dsh-vs-btn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;text-decoration:none;cursor:pointer;white-space:nowrap}',
      '[data-dsh-vs] .dsh-vs-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}',
      '[data-dsh-vs] .dsh-vs-btn-sm{height:28px;padding:0 10px;font-size:12px}',
      '[data-dsh-vs] .dsh-vs-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#4f7cff);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '[data-dsh-vs] .dsh-vs-btn-primary:hover{background:var(--dsw-alias-button-primary-hover,#3f6be0)}',
      '[data-dsh-vs] .dsh-vs-btn:disabled{opacity:.5;cursor:default}',
      '[data-dsh-vs] .dsh-vs-textbtn{padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary,#4f7cff);font:inherit;font-size:12px;cursor:pointer}',
      '[data-dsh-vs] .dsh-vs-textbtn:disabled{opacity:.5;cursor:default}',
      '[data-dsh-vs] .dsh-vs-footer{display:flex;align-items:center;gap:12px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
      '[data-dsh-vs] .dsh-vs-status{margin-left:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919e);text-align:right}',
      '[data-dsh-vs] .dsh-vs-status.is-error{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '[data-dsh-vs] .dsh-vs-loading{padding:16px 0;color:var(--dsw-alias-label-tertiary,#8a919e)}',
      '@media(max-width:720px){[data-dsh-vs] .dsh-vs-grid{grid-template-columns:1fr}[data-dsh-vs] .dsh-vs-span-2{grid-column:auto}}',
    ].join('');

    function useInjectedStyle() {
      useEffect(() => {
        if (typeof document === 'undefined' || document.getElementById('dsh-vs-core-style')) return;
        const style = document.createElement('style');
        style.id = 'dsh-vs-core-style';
        style.textContent = CSS;
        document.head.appendChild(style);
      }, []);
    }

    function apiConfig() {
      const injected = globalThis.__DSH_VIDEO_STORYBOARD_SETTINGS__;
      if (!injected || typeof injected.url !== 'string') return null;
      const url = new URL(injected.url);
      const token = url.searchParams.get('token') || '';
      const base = url.pathname.replace(/\/+$/, '') + '/api';
      return { token: token, base: base };
    }

    async function apiCall(api, action, body) {
      const res = await fetch(api.base + action, {
        method: body === undefined ? 'GET' : 'POST',
        cache: 'no-store',
        headers: body === undefined
          ? { 'x-settings-token': api.token }
          : { 'x-settings-token': api.token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    }

    function formFromState(state) {
      const asr = state && state.asr ? state.asr : {};
      const video = state && state.video ? state.video : {};
      return {
        enabled: asr.enabled !== false,
        baseUrl: typeof asr.baseUrl === 'string' ? asr.baseUrl : '',
        model: typeof asr.model === 'string' ? asr.model : '',
        language: typeof asr.language === 'string' ? asr.language : '',
        hasKey: Boolean(asr.hasKey),
        keyFromEnv: Boolean(asr.keyFromEnv),
        effective: asr.effective || {},
        browserPort: video.browserPort ? String(video.browserPort) : '',
        launchBrowser: video.launchBrowser === true,
        cookies: typeof video.cookies === 'string' ? video.cookies : '',
        storyboardAuto: video.storyboardAuto !== false,
        videoEnvOverrides: Array.isArray(video.envOverrides) ? video.envOverrides : [],
      };
    }

    function Toggle(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked,
        'aria-label': props.label,
        className: 'dsh-vs-toggle' + (props.checked ? ' is-on' : ''),
        onClick: () => props.onChange(!props.checked),
      }, h('span', { className: 'dsh-vs-toggle-knob' }));
    }

    function TextField(props) {
      return h('div', { className: 'dsh-vs-field' + (props.wide ? ' dsh-vs-span-2' : '') },
        h('span', { className: 'dsh-vs-label' }, props.label),
        h('input', {
          className: 'dsh-vs-input',
          type: props.type || 'text',
          value: props.value,
          placeholder: props.placeholder || '',
          autoComplete: 'off',
          spellCheck: false,
          onChange: event => props.onChange(event.target.value),
          onBlur: props.onBlur ? () => props.onBlur() : undefined,
        }),
        props.hint ? h('span', { className: 'dsh-vs-hint' }, props.hint) : null,
      );
    }

    function depAction(check) {
      if (check.ok || !check.downloadUrl || !/^https:\/\//.test(check.downloadUrl)) return null;
      const label = check.downloadLabel || '查看';
      return h('a', {
        className: 'dsh-vs-btn dsh-vs-btn-sm',
        href: check.downloadUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, /下载/.test(label) ? '下载' : /获取/.test(label) ? '获取' : '查看');
    }

    function SettingsTab() {
      useInjectedStyle();
      const [form, setForm] = useState(null);
      const [keyValue, setKeyValue] = useState('');
      const [clearKey, setClearKey] = useState(false);
      const [checks, setChecks] = useState([]);
      const [checking, setChecking] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const formRef = React.useRef(null);
      const keyValueRef = React.useRef('');
      const clearKeyRef = React.useRef(false);
      const firstRender = React.useRef(true);
      const saving = React.useRef(false);
      const pending = React.useRef(false);
      formRef.current = form;
      keyValueRef.current = keyValue;
      clearKeyRef.current = clearKey;

      async function runCheck(api) {
        const target = api || apiConfig();
        if (!target) {
          setError('设置接口未注入，请重启 DSH。');
          return;
        }
        setChecking(true);
        setError('');
        try {
          const data = await apiCall(target, '/check', {});
          setChecks(Array.isArray(data.checks) ? data.checks : []);
          setNotice('环境检查完成。');
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setChecking(false);
        }
      }

      useEffect(() => {
        let cancelled = false;
        const api = apiConfig();
        if (!api) {
          setError('设置接口未注入，请重启 DSH。');
          return undefined;
        }
        apiCall(api, '/state').then(state => {
          if (cancelled) return;
          setForm(formFromState(state));
          void runCheck(api);
        }).catch(e => {
          if (cancelled) return;
          setError(String(e && e.message ? e.message : e));
        });
        return () => { cancelled = true; };
      }, []);

      function validationError(current) {
        const browserPort = current.browserPort === '' ? false : Number(current.browserPort);
        if (browserPort !== false
          && (!Number.isInteger(browserPort) || browserPort < 1 || browserPort > 65535)) {
          return '浏览器调试端口必须是 1-65535 的整数。';
        }
        return '';
      }

      async function save() {
        const current = formRef.current;
        if (!current) return;
        if (saving.current) {
          pending.current = true;
          return;
        }
        const api = apiConfig();
        if (!api) {
          setError('设置接口未注入，请重启 DSH。');
          return;
        }
        const invalid = validationError(current);
        if (invalid) {
          setError(invalid);
          setNotice('');
          return;
        }
        const submittedKey = keyValueRef.current;
        const submittedClear = clearKeyRef.current;
        saving.current = true;
        setError('');
        setNotice('');
        try {
          const asr = {
            enabled: current.enabled,
            baseUrl: current.baseUrl,
            model: current.model,
            language: current.language,
          };
          if (submittedKey.trim()) asr.key = submittedKey.trim();
          if (submittedClear) asr.clearKey = true;
          const video = {
            browserPort: current.browserPort === '' ? false : Number(current.browserPort),
            launchBrowser: current.launchBrowser,
            cookies: current.cookies,
            storyboardAuto: current.storyboardAuto,
          };
          const state = await apiCall(api, '/save', { asr: asr, video: video });
          setForm(prev => prev ? {
            ...prev,
            hasKey: Boolean(state.asr && state.asr.hasKey),
            keyFromEnv: Boolean(state.asr && state.asr.keyFromEnv),
            effective: (state.asr && state.asr.effective) || prev.effective,
          } : formFromState(state));
          if (keyValueRef.current === submittedKey) setKeyValue('');
          if (submittedClear) setClearKey(false);
          setNotice('已自动保存；下一次工具调用生效。');
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          saving.current = false;
          if (pending.current) {
            pending.current = false;
            setTimeout(() => { void save(); }, 0);
          }
        }
      }

      useEffect(() => {
        if (!form) return undefined;
        if (firstRender.current) {
          firstRender.current = false;
          return undefined;
        }
        const timer = setTimeout(() => { void save(); }, 600);
        return () => clearTimeout(timer);
      }, [
        form && form.enabled,
        form && form.baseUrl,
        form && form.model,
        form && form.language,
        form && form.browserPort,
        form && form.launchBrowser,
        form && form.cookies,
        form && form.storyboardAuto,
      ]);

      if (!form) {
        return h('div', { 'data-dsh-vs': 'core', className: 'dsh-vs dsh-vs-loading' }, error || '正在加载设置…');
      }

      const keyHint = form.keyFromEnv
        ? '环境变量 DSH_ASR_KEY 优先；这里保存的 key 不会覆盖它。'
        : form.hasKey
          ? '已保存 key；留空保持，勾选下方可删除。'
          : '本机端点通常不需要；只写不读。';
      const visibleChecks = checks.filter(item => item.id !== 'browser');
      const optionalIds = { ytdlp: true, python: true, speech: true };

      return h('div', { 'data-dsh-vs': 'core', className: 'dsh-vs' },
        h('section', { className: 'dsh-vs-section' },
          h('div', { className: 'dsh-vs-section-head' },
            h('h3', { className: 'dsh-vs-section-title' }, '转写'),
            h('div', { className: 'dsh-vs-inline' },
              h('span', { className: 'dsh-vs-hint' }, '自动转写'),
              h(Toggle, {
                checked: form.enabled,
                label: '自动转写',
                onChange: value => setForm(prev => ({ ...prev, enabled: value })),
              }),
            ),
          ),
          h('div', { className: 'dsh-vs-grid' },
            h(TextField, {
              label: 'Base URL',
              value: form.baseUrl,
              wide: true,
              placeholder: 'https://api.siliconflow.cn/v1',
              hint: 'OpenAI 兼容的 /audio/transcriptions 端点；留空用内置默认。',
              onChange: value => setForm(prev => ({ ...prev, baseUrl: value })),
            }),
            h(TextField, {
              label: '模型',
              value: form.model,
              placeholder: 'FunAudioLLM/SenseVoiceSmall',
              onChange: value => setForm(prev => ({ ...prev, model: value })),
            }),
            h(TextField, {
              label: '语言',
              value: form.language,
              placeholder: 'zh',
              onChange: value => setForm(prev => ({ ...prev, language: value })),
            }),
            h(TextField, {
              label: 'API Key',
              value: keyValue,
              type: 'password',
              wide: true,
              placeholder: form.hasKey ? '已保存；留空保持' : '可留空',
              hint: keyHint,
              onChange: value => setKeyValue(value),
              onBlur: () => { if (keyValueRef.current.trim()) void save(); },
            }),
          ),
          form.hasKey
            ? h('label', { className: 'dsh-vs-check' },
                h('input', {
                  type: 'checkbox',
                  checked: clearKey,
                  onChange: event => {
                    const checked = event.target.checked;
                    clearKeyRef.current = checked;
                    setClearKey(checked);
                    void save();
                  },
                }),
                '删除已保存的 key',
              )
            : null,
          form.effective && (form.effective.source || form.effective.baseUrl || form.effective.model)
            ? h('p', { className: 'dsh-vs-effective' },
                '当前生效：' + [form.effective.source, form.effective.baseUrl, form.effective.model]
                  .filter(Boolean).join(' · '))
            : null,
        ),
        h('section', { className: 'dsh-vs-section' },
          h('div', { className: 'dsh-vs-section-head' },
            h('h3', { className: 'dsh-vs-section-title' }, '视频与浏览器'),
          ),
          h('div', { className: 'dsh-vs-grid' },
            h(TextField, {
              label: '浏览器调试端口',
              value: form.browserPort,
              type: 'number',
              placeholder: '9333',
              hint: '留空关闭；Edge 需要带 --remote-debugging-port 启动。',
              onChange: value => setForm(prev => ({ ...prev, browserPort: value })),
            }),
            h('div', { className: 'dsh-vs-field' },
              h('span', { className: 'dsh-vs-label' }, '允许插件打开浏览器'),
              h('div', { className: 'dsh-vs-inline' },
                h(Toggle, {
                  checked: form.launchBrowser,
                  label: '允许插件打开浏览器',
                  onChange: value => setForm(prev => ({ ...prev, launchBrowser: value })),
                }),
                h('span', { className: 'dsh-vs-hint' }, form.launchBrowser ? '已允许' : '默认关闭'),
              ),
              h('span', { className: 'dsh-vs-hint' }, '关闭时只读取已经打开的浏览器。'),
            ),
            h(TextField, {
              label: 'Cookies 文件',
              value: form.cookies,
              wide: true,
              placeholder: '例如 C:\\Users\\me\\.dsh\\cookies.txt',
              hint: 'Netscape cookies.txt，给需要登录的 B 站/YouTube 用；也可用 DSH_VIDEO_COOKIES 环境变量。',
              onChange: value => setForm(prev => ({ ...prev, cookies: value })),
            }),
            h('div', { className: 'dsh-vs-field' },
              h('span', { className: 'dsh-vs-label' }, '自动生成分镜'),
              h('div', { className: 'dsh-vs-inline' },
                h(Toggle, {
                  checked: form.storyboardAuto,
                  label: '自动生成分镜',
                  onChange: value => setForm(prev => ({ ...prev, storyboardAuto: value })),
                }),
                h('span', { className: 'dsh-vs-hint' }, form.storyboardAuto ? '已开启' : '已关闭'),
              ),
              h('span', { className: 'dsh-vs-hint' }, '关闭后 storyboard.auto=false；仍可显式调用工具。'),
            ),
          ),
          form.videoEnvOverrides.length
            ? h('p', { className: 'dsh-vs-effective' },
                '环境变量优先：' + form.videoEnvOverrides.join('、') + '；这里的改动不会覆盖它们。')
            : null,
        ),
        h('section', { className: 'dsh-vs-section' },
          h('div', { className: 'dsh-vs-section-head' },
            h('h3', { className: 'dsh-vs-section-title' }, '依赖'),
            h('button', {
              type: 'button',
              className: 'dsh-vs-textbtn',
              disabled: checking,
              onClick: () => { setNotice(''); void runCheck(); },
            }, checking ? '检查中…' : '重新检查'),
          ),
          h('p', { className: 'dsh-vs-hint', style: { margin: '0 0 6px' } },
            '缺少时显示官方下载按钮；插件不会自动安装或执行下载的文件。'),
          visibleChecks.length
            ? h('div', { className: 'dsh-vs-deps' }, visibleChecks.map(check =>
                h('div', { className: 'dsh-vs-dep', key: check.id },
                  h('span', {
                    className: 'dsh-vs-dot'
                      + (check.ok ? '' : optionalIds[check.id] ? ' is-warn' : ' is-bad'),
                  }),
                  h('div', { className: 'dsh-vs-dep-main' },
                    h('div', { className: 'dsh-vs-dep-name' }, check.label || check.id),
                    h('div', { className: 'dsh-vs-dep-detail', title: check.detail || '' }, check.detail || ''),
                  ),
                  depAction(check),
                )))
            : h('p', { className: 'dsh-vs-hint' }, checking ? '正在检查…' : '尚未检查。'),
        ),
        h('div', { className: 'dsh-vs-footer' },
          h('span', { className: 'dsh-vs-status' + (error ? ' is-error' : ''), role: 'status' },
            error || notice),
        ),
      );
    }

    function BundleConfig(props) {
      return props && props.view === 'page' ? h(SettingsTab) : null;
    }

    function apply(ctx) {
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'video-storyboard',
        order: 20,
        label: () => '视频分镜',
      }, SettingsTab));
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-video-storyboard',
      }, BundleConfig));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
