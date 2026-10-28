// 插件面板里的「不兼容安装」页。
//
// 管理器把版本检查放在安装流程里，对不上的包直接拒掉，然后原样回滚。它自己留了版本
// 豁免这个出口，但只有命令行或它自己的弹窗能走。这里把它做成一个页面：列出当前被拒的
// 插件，一键授权并安装，装完交给后台扫描去对齐声明、建兼容环境。
//
// 界面和 Host 之间走同源 HTTP，不碰 typert 的 remote 门面。动态加载的客户端模块拿不到
// 那个服务（它的上下文里没有），而 fetch 只要同源就行。Host 侧对应
// /doctor/incompatible 与 /doctor/install 两条路由。
window.__ModuleLoader__.load({
  id: 'dsh-request-doctor',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const inject = ['slots']

    // 界面文案。语言服务不再参与：动态模块拿不到它，标签还曾经因此显示成键名。
    const TEXT = {
      tabLabel: '不兼容安装',
      intro: '下面是被当前 DSH 版本拒装的插件。装它们只需要一步：先按管理器的规则授权这个版本，再让它自己装。装完之后，声明对齐和兼容环境会自动补上。',
      placeholder: '包名@版本，例如 dsh-ssh-ops@0.4.0',
      install: '授权并安装',
      requires: '要求运行在',
      none: '当前没有被拒装的插件。可以在上面直接填包名安装，或点「重新扫描」重算一遍。',
      working: '正在处理',
      done: '已装好，兼容环境会在后台补上',
      failed: '没能装上',
      rescan: '重新扫描',
      offline: '连不上 Host 侧的安装路由，可以改用命令：',
    }

    const style = {
      column: { display: 'flex', flexDirection: 'column', gap: 14, width: '100%', minWidth: 0 },
      title: { margin: 0, fontSize: '0.95em', fontWeight: 600 },
      text: { margin: 0, fontSize: '0.9em', lineHeight: 1.6, opacity: 0.8 },
      hush: { margin: 0, fontSize: '0.9em', opacity: 0.7 },
      mono: { margin: 0, fontSize: '0.85em', opacity: 0.75, fontFamily: 'monospace' },
      line: { display: 'flex', gap: 8, alignItems: 'center' },
      field: {
        flex: 1, padding: '6px 10px', borderRadius: 8, font: 'inherit',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
        background: 'var(--dsw-alias-bg-l1, transparent)', color: 'inherit',
      },
      press: {
        padding: '6px 14px', borderRadius: 8, cursor: 'pointer', font: 'inherit',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
        background: 'var(--dsw-alias-bg-l2, transparent)', color: 'inherit',
      },
      card: {
        display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
      },
    }

    // 统一走同源路由：取回 JSON，失败就把原因抛出去，由调用方决定怎么显示。
    async function requestJson(path, init) {
      const response = await fetch(path, init)
      return response.json()
    }

    // 读一次被拒插件清单。Host 侧已经把不可用的行筛掉了。
    async function loadRows() {
      const data = await requestJson('/doctor/incompatible', { headers: { accept: 'application/json' } })
      if (data.ok !== true) throw new Error(data.reason || 'host declined')
      return data.rows || []
    }

    // 装一个包。授权、重试、声明对齐都在 Host 侧完成，这里只拿结果。
    async function postInstall(spec) {
      const data = await requestJson('/doctor/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec }),
      })
      return { ok: data.ok === true, reason: data.text || '' }
    }

    // 让 Host 立刻重算一轮审计，不用等下一次定时扫描。
    async function postRescan() {
      const data = await requestJson('/doctor/rescan')
      return { ok: data.ok === true, reason: data.reason || '' }
    }

    function IncompatiblePanel() {
      const [rows, setRows] = React.useState([])
      const [spec, setSpec] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')

      const refresh = React.useCallback(async () => {
        try {
          setRows(await loadRows())
        } catch (error) {
          // 路由不通就把可用的替代办法说出来，不留空白。
          setNote(`${TEXT.offline} /doctor install <包名>（${String((error && error.message) || error)}）`)
        }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      // 两个入口共用同一段收尾：跑、报结果、刷新列表。
      async function run(label, task) {
        setBusy(true)
        setNote(`${TEXT.working} ${label}`)
        try {
          const outcome = await task()
          setNote(outcome.ok ? `${TEXT.done}：${label}` : `${TEXT.failed}：${outcome.reason}`)
          await refresh()
        } catch (error) {
          setNote(`${TEXT.failed}：${String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      const submit = () => {
        const trimmed = spec.trim()
        if (trimmed === '') return
        run(trimmed, () => postInstall(trimmed))
      }

      const children = []
      children.push(h('p', { key: 'title', style: style.title }, TEXT.tabLabel))
      children.push(h('p', { key: 'intro', style: style.text }, TEXT.intro))
      children.push(h('div', { key: 'entry', style: style.line },
        h('input', {
          value: spec, style: style.field, placeholder: TEXT.placeholder,
          onChange: (event) => setSpec(event.target.value),
        }),
        h('button', {
          type: 'button', style: style.press, disabled: busy, onClick: submit,
        }, TEXT.install),
        h('button', {
          type: 'button', style: style.press, disabled: busy,
          onClick: () => run(TEXT.rescan, postRescan),
          style: { ...style.press, opacity: 0.8 },
        }, TEXT.rescan)))

      if (rows.length === 0) {
        children.push(h('p', { key: 'none', style: style.hush }, TEXT.none))
      } else {
        children.push(h('div', { key: 'rows', style: style.column }, rows.map((row) => h('div', {
          key: `${row.name}@${row.version}`, style: style.card,
        },
        h('div', { style: style.title }, `${row.name}@${row.version}`),
        h('div', { style: style.hush }, `${TEXT.requires} ${row.runtimeVersion || '?'}`),
        h('button', {
          type: 'button', style: style.press, disabled: busy,
          onClick: () => run(`${row.name}@${row.version}`, () => postInstall(`${row.name}@${row.version}`)),
        }, TEXT.install)))))
      }

      // Host 的返回是多行文本（安装结果、位置、兼容环境），按原样保留换行。
      if (note !== '') children.push(h('p', { key: 'note', style: { ...style.hush, whiteSpace: 'pre-wrap' } }, note))
      return h('div', { style: style.column }, ...children)
    }

    function apply(ctx) {
      if (typeof ctx.slots?.inject !== 'function') return
      const cells = [
        ['plugins.tab', 'requestDoctorIncompatible', 5, TEXT.tabLabel, IncompatiblePanel],
        ['settings.plugins.tab', 'requestDoctorSettingsTab', 20, TEXT.tabLabel, IncompatiblePanel],
      ]
      for (const [slot, id, order, label, Component] of cells) {
        ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id, order, label }, Component))
      }
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
