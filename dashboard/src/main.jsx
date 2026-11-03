import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { bytes, clientName, compact, duration, fields, makeHandoff, num, time, trafficLabel } from './format.mjs';
import './style.css';

function Icon({name,size=19,...props}) {
  const paths={pulse:<path d="M3 12h5l3-8 4 16 3-8h3"/>,grid:<><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,diagnose:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5M7 11h2l1.5-3 2 6 1.5-3"/></>,file:<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/></>,help:<><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 2-2.5 2-2.5 4M12 17h.01"/></>,refresh:<><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/></>,arrow:<path d="M5 12h14m-5-5 5 5-5 5"/>,copy:<><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,download:<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>,check:<path d="m5 12 4 4L19 6"/>,pause:<path d="M8 5v14M16 5v14"/>,play:<path d="m8 4 12 8-12 8z"/>,chevron:<path d="m8 5 7 7-7 7"/>,alert:<><path d="m12 3 10 18H2zM12 9v5M12 17h.01"/></>};
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]??paths.pulse}</svg>;
}
const pages=[['overview','grid','会话总览'],['diagnostics','diagnose','诊断与依据'],['handoff','file','交接工作台'],['help','help','接入说明']];
function useMonitor(key,setKey,minutes,auto,epoch) {
  const [bootstrap,setBootstrap]=useState(null),[payload,setPayload]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();let timer;
    async function read(path) {
      const res=await fetch(path,{signal:controller.signal});
      const data=await res.json();
      if(!res.ok) throw new Error(data.message??'本地数据暂不可读，请刷新重试。');
      return data;
    }
    async function tick() {
      setBusy(true);
      try {
        const boot=await read('/api/bootstrap');
        if(controller.signal.aborted) return;
        setBootstrap(boot);
        if(!key&&boot.initial_key) {setKey(boot.initial_key);return;}
        if(key&&boot.ok) {
          const data=await read('/api/session?key='+encodeURIComponent(key)+'&minutes='+minutes);
          if(controller.signal.aborted) return;
          if(!data.ok) throw new Error(data.message??'采集状态暂不可用。');
          setPayload({key,data});
        }
        if(!boot.ok) setPayload(null);
        setError('');
      } catch(e) {if(!controller.signal.aborted) setError(e.message);}
      finally {
        if(!controller.signal.aborted) {setBusy(false);if(auto) timer=setTimeout(tick,5000);}
      }
    }
    tick();
    return ()=>{controller.abort();clearTimeout(timer);};
  },[key,setKey,minutes,auto,epoch]);
  return {bootstrap,data:payload?.key===key?payload.data:null,error,busy};
}
function Sidebar({page,setPage,bootstrap,selection,setSelection}) {
  const [filter,setFilter]=useState('all');
  const sessions=(bootstrap?.sessions??[]).filter(s=>filter==='all'||s.client===filter);
  return <aside className="sidebar">
    <div className="brand"><span className="brand-mark"><Icon name="pulse" size={23}/></span><span>Context Guard<small>会话监测与交接</small></span></div>
    <nav aria-label="主导航">{pages.map(([key,icon,label])=><button key={key} className={'nav-item '+(page===key?'active':'')} aria-current={page===key?'page':undefined} onClick={()=>setPage(key)}><Icon name={icon}/>{label}{page===key&&<span className="nav-dot"/>}</button>)}</nav>
    <div className="session-heading"><span>已记录会话</span><span>{bootstrap?.sessions?.length??0}</span></div>
    <label className="sr-only" htmlFor="client-filter">按客户端筛选</label><select id="client-filter" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部客户端</option>{['codex','claude','gemini','grok','generic'].map(c=><option key={c} value={c}>{clientName(c)}</option>)}</select>
    <div className="session-list" aria-label="选择会话">{sessions.map(s=><button key={s.key} className={'session '+(selection===s.key?'selected':'')} onClick={()=>setSelection(s.key)} aria-pressed={selection===s.key} title={s.raw_session+' · '+s.agent}>
      <span className={'session-logo '+s.client}>{clientName(s.client).slice(0,1)}</span><span className="session-text"><strong>{clientName(s.client)}{s.client==='generic'&&s.source?' · '+s.source:''}</strong><small>{s.raw_session.slice(0,8)}…{s.raw_session.slice(-4)}</small><small>{s.agent!=='root'?s.agent+' · ':''}{time(s.activity,true)}</small></span>
    </button>)}{sessions.length===0&&<p className="sidebar-empty">没有对应记录。接入客户端后，会话会出现在这里。</p>}</div>
    <div className="sidebar-footer"><span className={'dot '+(bootstrap?.ok?'green':'')}/>{bootstrap?.ok?'本地数据已连接':'等待本地数据'}<small>数据留在本机 · 不调用模型</small></div>
  </aside>;
}
function Empty({bootstrap,selection,busy,setPage}) {
  return <section className="empty-state"><span className="empty-icon"><Icon name="pulse" size={38}/></span><h2>{busy?'正在读取本地记录':!bootstrap?.ok?'先接入一份真实记录':'选择要查看的会话'}</h2><p>{bootstrap?.message??(bootstrap?.initial_unmatched?'指定的会话尚未出现在这份数据库中，请先确认事件接入。':'从左侧选择客户端和会话。每个窗口独立查看，不会把最新记录自动认作当前窗口。')}</p>{bootstrap?.state_path&&<code className="path">{bootstrap.state_path}</code>}<button className="button" onClick={()=>setPage('help')}>查看接入方法<Icon name="arrow" size={16}/></button></section>;
}
function Metrics({report:r}) {
  const t=r.traffic,s=r.speed,cache=r.tokens.latest_input>0&&r.tokens.latest_cached_input!=null?r.tokens.latest_cached_input/r.tokens.latest_input*100:null;
  const items=[
    {label:'已记录压缩',value:r.compactions.known_total==null?num(r.compactions.triggered_since_activation):num(r.compactions.known_total),unit:'次',hint:r.compactions.known_total==null?'仅触发事件 · 完成次数未知':r.compactions.coverage==='since_activation_only'?'仅覆盖接入后的完成记录':'覆盖指定历史记录与接入后事件',icon:'file'},
    {label:r.tokens.latest_source==='current_context_snapshot_not_cumulative'?'当前输入快照':r.tokens.latest_source==='stream_chunk_not_added_to_request_totals'?'最近输入观察':'最近一次输入',value:compact(r.tokens.latest_input),unit:'Token',hint:r.tokens.latest_input==null?'客户端尚未提供 Token':cache==null?'缓存读取数量未知':'缓存读取 '+num(cache,1)+'% · '+num(r.tokens.latest_cached_input)+' Token',icon:'pulse'},
    {label:'近期有效速率',value:s.status==='measured_request_end_to_end'?num(s.recent_output_tokens_per_second,1):'—',unit:s.status==='measured_request_end_to_end'?'Token/s':'',hint:s.status==='measured_request_end_to_end'?'为早期可比样本的 '+num(s.ratio*100,1)+'%':'可比样本不足，暂不判断下降',icon:'diagnose'},
    {label:'采样窗上传',value:['measured','stale'].includes(t.status)?bytes(t.upload_bytes):'—',unit:'',hint:['measured','stale'].includes(t.status)?(t.status==='stale'?'历史数据 · ':'')+num(t.seconds/60,1)+' 分钟 · '+(t.provider==='mihomo'?'本机代理全量':'网卡 '+t.interface):'未接入或有效采样不足',icon:'refresh'},
  ];
  return <div className="metrics">{items.map(item=><article className="metric" key={item.label}><div className="metric-label">{item.label}<Icon name={item.icon} size={17}/></div><div className="metric-value">{item.value}<span>{item.unit}</span></div><p>{item.hint}</p></article>)}</div>;
}
function TrendChart({points,series,formatter=compact,empty='这个时间范围没有可用记录。'}) {
  const [small,setSmall]=useState(()=>window.matchMedia('(max-width:640px)').matches);
  useEffect(()=>{const media=window.matchMedia('(max-width:640px)'),change=()=>setSmall(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
  const values=points.flatMap(p=>series.map(s=>p[s.key])).filter(v=>v!=null&&Number.isFinite(v));
  if(!values.length) return <div className="chart-empty"><Icon name="pulse" size={27}/><p>{empty}</p><small>缺失值不会补成 0，也不会生成演示数据。</small></div>;
  const w=small?360:760,h=246,left=small?45:60,right=small?12:18,top=19,bottom=32,max=Math.max(...values,1)*1.13,minTs=Math.min(...points.map(p=>p.ts)),maxTs=Math.max(...points.map(p=>p.ts));
  const x=p=>left+(p.ts-minTs)/Math.max(maxTs-minTs,1)*(w-left-right),y=v=>h-bottom-v/max*(h-top-bottom);
  const segments=s=>{const segments=[];let segment=[];for(const p of points){if(p[s.key]==null){if(segment.length)segments.push(segment);segment=[];}else segment.push(p);}if(segment.length)segments.push(segment);return segments;};
  return <div className="chart-wrap"><svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={series.map(s=>s.label).join('与')+'趋势'}>
    {[0,.25,.5,.75,1].map(v=><g key={v}><line x1={left} x2={w-right} y1={y(max*v)} y2={y(max*v)} stroke="#e8edf4" strokeDasharray={v?'3 5':undefined}/><text x={left-10} y={y(max*v)+4} textAnchor="end">{formatter(max*v)}</text></g>)}
    {[0,.33,.66,1].map(v=><text key={v} x={left+v*(w-left-right)} y={h-8} textAnchor={v===0?'start':v===1?'end':'middle'}>{time(minTs+v*(maxTs-minTs)).slice(0,5)}</text>)}
    {series.map(s=><g key={s.key}>{segments(s).map((segment,i)=><React.Fragment key={i}>{segment.length>1&&<polyline fill="none" stroke={s.color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" points={segment.map(p=>x(p)+','+y(p[s.key])).join(' ')}/>} {segment.filter((p,i)=>segment.length<18||i===segment.length-1).map((p,i)=><circle key={i} cx={x(p)} cy={y(p[s.key])} r="3.1" fill={s.color}><title>{time(p.ts,true)} · {s.label} {formatter(p[s.key])}</title></circle>)}</React.Fragment>)}</g>)}
  </svg><div className="legend">{series.map(s=><span key={s.key}><i style={{background:s.color}}/>{s.label}</span>)}</div></div>;
}
function Trends({data,minutes,setMinutes}) {
  const [metric,setMetric]=useState('tokens'),h=data.history;
  const options={tokens:{title:'输入与缓存读取',detail:'每个点对应一条请求记录；缓存读取是输入的子集。',points:h.requests.map(r=>({ts:r.ended??r.started,input:r.input_tokens,cache:r.cached_tokens})),series:[{key:'input',label:'输入 Token',color:'#4b5cdb'},{key:'cache',label:'缓存读取',color:'#92a5e8'}]},latency:{title:'单次请求耗时',detail:'包含排队、网络、推理和生成；不包含请求之间的工具执行。',points:h.requests.map(r=>({ts:r.ended??r.started,ms:r.elapsed_ms})),series:[{key:'ms',label:'请求耗时',color:'#4b5cdb'}],formatter:duration},rate:{title:'同组有效请求速率',detail:'仅展示最近请求所属的可比组；不同模型、规模和计时口径不混比。',points:h.rates,series:[{key:'value',label:'输出 Token/s',color:'#208579'}],empty:'当前没有可无歧义配对且分项完整的同组请求。'},traffic:{title:'采样窗网络速率',detail:trafficLabel(data.report.traffic)+'；最多 '+num(h.traffic_window_seconds/60)+' 分钟，同源同计数段，不归因于单个窗口。',points:h.traffic,series:[{key:'upload_per_second',label:'上传 /s',color:'#4b5cdb'},{key:'download_per_second',label:'下载 /s',color:'#22a593'}],formatter:bytes}};
  const o=options[metric];
  return <section className="panel trend-panel"><div className="panel-head"><div><h2>请求与流量趋势</h2><p>{o.title}</p></div><div className="segmented" aria-label="请求历史范围">{[[30,'30 分钟'],[120,'2 小时'],[0,'全部']].map(([n,label])=><button key={n} aria-pressed={minutes===n} className={minutes===n?'selected':''} onClick={()=>setMinutes(n)}>{label}</button>)}</div></div>
    <div className="chart-tabs" role="group" aria-label="趋势指标">{[['tokens','输入 Token'],['latency','请求耗时'],['rate','有效速率'],['traffic','上传 / 下载']].map(([m,label])=><button key={m} className={metric===m?'selected':''} aria-pressed={metric===m} onClick={()=>setMetric(m)}>{label}</button>)}</div>
    <TrendChart points={o.points} series={o.series} formatter={o.formatter} empty={o.empty}/><p className="chart-note">{o.detail}{metric!=='traffic'&&h.truncated?' 当前显示该范围最近 500 条记录。':''}</p>
  </section>;
}
function Decision({data,setPage}) {
  const alerts=data.report.alerts,strong=alerts.some(a=>a.severity==='handoff');
  return <section className={'decision '+(strong?'handoff':'')}><div className="decision-label"><Icon name={alerts.length?'alert':'check'} size={18}/>{strong?'建议准备交接':alerts.length?'建议阶段检查':'正在记录，暂无新提醒'}</div><h2>{strong?'先到检查点，\n再换新对话。':alerts.length?'现在可以继续，\n先看提醒依据。':'保留记录，\n按任务阶段推进。'}</h2><p>{alerts[0]?.message??'当前已取得的指标没有触发提醒；缺失指标仍为未知。'}</p><div className="decision-facts"><span>上下文占比<strong>{data.report.context.used_percentage==null?'未知':num(data.report.context.used_percentage,1)+'%'}</strong></span><span>已记录完成请求<strong>{num(data.report.tokens.completed_requests)}</strong></span><span>待配对 / 未解配对<strong>{num(data.report.requests.pending)} / {num(data.report.requests.unresolved)}</strong></span></div><button className="text-button" onClick={()=>setPage('diagnostics')}>查看诊断依据<Icon name="arrow" size={16}/></button><small>试行阈值只用于提醒，不能证明模型能力下降。</small></section>;
}
function Requests({data}) {
  const [expanded,setExpanded]=useState(false),rows=data.history.requests.slice().reverse().slice(0,expanded?50:8);
  return <section className="panel request-panel"><div className="panel-head"><div><h2>最近请求</h2><p>当前范围共 {num(data.history.total_requests)} 条 · 正文不会记录到监测库</p></div>{data.history.requests.length>8&&<button className="text-button" onClick={()=>setExpanded(v=>!v)}>{expanded?'收起':'查看最近 50 条'}<Icon name="chevron" size={15}/></button>}</div><div className="table-scroll"><table><thead><tr><th>时间</th><th>模型 / 强度</th><th>输入 Token</th><th>缓存读取</th><th>输出 Token</th><th>请求耗时</th><th>状态</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td className="mono">{time(r.ended??r.started)}</td><td><strong>{r.model}</strong><small>{r.effort??'强度未知'}</small></td><td className="mono">{num(r.input_tokens)}</td><td className="mono muted">{num(r.cached_tokens)}</td><td className="mono">{num(r.output_tokens)}</td><td className="mono">{duration(r.elapsed_ms)}</td><td><span className={'request-status '+r.status}>{({completed:'已完成',failed:'失败',cancelled:'已取消',pending:'等待结束',unresolved:'未解配对',unknown:'未知'}[r.status]??r.status)}</span></td></tr>)}{rows.length===0&&<tr><td colSpan="7" className="table-empty">这个客户端或所选时间范围没有请求记录，状态栏快照不会被伪装成模型请求。</td></tr>}</tbody></table></div></section>;
}
function Diagnostics({data}) {
  const r=data.report;
  return <><div className="section-intro"><h2>把观测与推测分开</h2><p>先看具体信号，再决定继续、检查网络，还是准备交接。</p></div><div className="diagnostic-list">{data.diagnostics.map(item=><article className={'diagnostic '+item.level} key={item.kind}><span className="diagnostic-icon"><Icon name={item.level==='unknown'?'help':'diagnose'}/></span><div><span className="small-label">{item.level==='unknown'?'数据缺口':'已观察到的信号'}</span><h3>{item.title}</h3><p>{item.evidence}</p><div className="next-action">下一步：{item.action}</div></div></article>)}</div><section className="panel coverage"><h2>这份记录覆盖什么</h2><dl><div><dt>客户端与会话</dt><dd>{clientName(r.client)} · <code>{r.external_session_id}</code> · {r.agent}</dd></div><div><dt>压缩记录</dt><dd>{r.compactions.coverage==='trigger_events_only'?'仅压缩触发事件，完成次数未知':r.compactions.coverage==='since_activation_only'?'仅覆盖启用采集后的完成事件':'指定历史记录与启用后的完成事件'}；未配对完成事件 {num(r.compactions.unpaired_postcompact_events)} 次</dd></div><div><dt>输入增长比较</dt><dd>{r.tokens.input_trend?'同模型早期与近期各 '+data.policy.trendSamples+' 次输入中位数 '+num(r.tokens.input_trend.baseline)+' → '+num(r.tokens.input_trend.recent)+'，为早期的 '+num(r.tokens.input_trend.ratio,2)+' 倍。':'同模型输入记录不足，当前不能比较。'}全已记录会话范围。</dd></div><div><dt>流量范围</dt><dd>{trafficLabel(r.traffic)}；跨程序、跨窗口，不能全部归给当前会话。{r.traffic.freshness_seconds!=null?' 最后采样距报告 '+num(r.traffic.freshness_seconds,1)+' 秒。':''}</dd></div><div><dt>计时范围</dt><dd>模型请求两端事件之间的耗时；可能包含排队、网络、推理与生成。首字延迟和服务端压力未知。</dd></div><div><dt>Token 总计</dt><dd>{num(r.tokens.recorded_total)}；仅计入有数值的完成请求，包含重复及缓存输入，不等于独立文本量或订阅剩余额度。</dd></div></dl></section></>;
}
function Handoff({data,draft,onChange,onSeed}) {
  const [notice,setNotice]=useState('');
  const markdown=useMemo(()=>makeHandoff(data,draft),[data,draft]);
  async function copy() {
    try {await navigator.clipboard.writeText(markdown);setNotice('已复制，可粘贴到新对话。');}
    catch {setNotice('浏览器未允许复制。请选中预览文字复制，或下载摘要。');}
  }
  function download() {
    const url=URL.createObjectURL(new Blob([markdown],{type:'text/markdown;charset=utf-8'})),a=document.createElement('a');
    a.href=url;a.download='handoff-'+data.report.client+'-'+new Date().toISOString().slice(0,10)+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice('摘要已交给浏览器下载。');
  }
  return <><div className="section-intro"><h2>让下一个对话接得上</h2><p>监测信息自动带入；任务进度由当前 Agent 提供或在这里补充。复制前核对已验证状态。</p></div><div className="handoff-grid"><section className="panel draft-panel"><div className="panel-head"><h2>任务进度</h2>{data.seed.status==='matched'&&<button className="text-button" onClick={()=>{onSeed(data.seed.fields);setNotice('已载入当前会话的 Agent 草稿，请核对。');}}>载入 Agent 草稿</button>}</div>{fields.map(([key,label])=><label className="draft-field" key={key}><span>{label}</span><textarea maxLength="8000" rows={key==='completed'||key==='next'?4:3} value={draft[key]??''} onChange={e=>onChange(key,e.target.value)} placeholder={{goal:'要完成什么？范围到哪里？',completed:'写清实际完成内容、验证结果及尚未验证的部分。',next:'下一项具体动作、未解决的问题与阻碍。',files:'项目路径、产物、分支、未提交修改及仍在运行的服务。',constraints:'已经授权的范围、需要保留的成果、失败路径与关键约束。'}[key]}/></label>)}<p className="draft-note">草稿仅保留在本页内存；关闭或刷新页面前请复制或下载。</p>{data.seed.status==='different_session'&&<p className="inline-warning">启动时提供的 Agent 草稿属于另一个会话，未载入。</p>}</section><section className="panel preview-panel"><div className="panel-head"><h2>交接摘要预览</h2><div className="actions"><button className="icon-button" aria-label="下载交接摘要" title="下载 .md" onClick={download}><Icon name="download"/></button><button className="button primary" onClick={copy}><Icon name="copy" size={16}/>复制摘要</button></div></div><div className="copy-notice" role="status">{notice||'生成的摘要包含来源、数据覆盖与未知指标。'}</div><pre tabIndex="0" aria-label="交接摘要预览">{markdown}</pre></section></div></>;
}
function Help({bootstrap}) {
  return <><div className="section-intro"><h2>接好事件，再看真实数据</h2><p>面板读取已采集记录。各客户端能提供的指标不同，缺失字段保持未知。</p></div><section className="panel help-panel"><h3>1. 安装 Skill，接入对应客户端</h3><p>支持 Codex、Claude Code、Gemini CLI、Grok；自建 Agent 可使用 v1 事件接口。仅放置 SKILL.md 不会自动产生监测数据。</p><a href="https://github.com/HOWLIDAY222/context-traffic-guard/blob/main/references/clients.md" target="_blank" rel="noreferrer">查看客户端接入说明<Icon name="arrow" size={16}/></a><h3>2. 指定本地状态目录启动面板</h3><pre>node --no-warnings scripts/dashboard.mjs --state-dir "&lt;STATE_DIR&gt;"</pre><p>当前读取目录：<code>{bootstrap?.state_path??'等待连接'}</code>。通过启动参数更换目录；面板不会扫描客户端历史、修改 Hook 或发起模型请求。</p><h3>3. 流量需要一个实际采样来源</h3><pre>node --no-warnings scripts/system-traffic.mjs list{'\n'}node --no-warnings scripts/system-traffic.mjs sample --interface "&lt;网卡名&gt;" --state-dir "&lt;STATE_DIR&gt;" --seconds 300</pre><p>Windows、macOS、Linux 均支持系统网卡来源。只选择一张实际网卡，所有程序的流量都会包含在内；不把物理网卡与 VPN/TUN 相加。已有兼容代理事件采样也可直接显示。</p><h3>4. 把任务进度带到交接工作台</h3><p>可手动填写。当前 Agent 也可将本会话的任务摘要写入指定 JSON 文件，再以 --handoff 指向它。绑定不匹配时不载入；面板不读取聊天正文，也不调用模型生成内容。</p><a href="https://github.com/HOWLIDAY222/context-traffic-guard/blob/main/references/dashboard.md" target="_blank" rel="noreferrer">查看面板与交接格式<Icon name="arrow" size={16}/></a></section></>;
}
function App() {
  const [page,setPage]=useState('overview'),[key,setKey]=useState(''),[minutes,setMinutes]=useState(30),[auto,setAuto]=useState(true),[epoch,setEpoch]=useState(0),[drafts,setDrafts]=useState({});
  const {bootstrap,data,error,busy}=useMonitor(key,setKey,minutes,auto,epoch);
  const changeField=useCallback((field,value)=>setDrafts(prev=>({...prev,[key]:{...(prev[key]??{}),[field]:value}})),[key]);
  useEffect(()=>{if(data?.seed.status==='matched')setDrafts(prev=>Object.hasOwn(prev,key)?prev:{...prev,[key]:data.seed.fields});},[data?.seed.status,key]);
  const selected=bootstrap?.sessions?.find(s=>s.key===key);
  return <div className="app"><Sidebar page={page} setPage={setPage} bootstrap={bootstrap} selection={key} setSelection={setKey}/><main><header className="topbar"><div className="breadcrumb">本地工作区<Icon name="chevron" size={13}/><span>{pages.find(p=>p[0]===page)[2]}</span></div><div className="topbar-actions"><button className="icon-button" aria-label={auto?'暂停自动刷新':'恢复自动刷新'} title={auto?'暂停自动刷新':'恢复自动刷新'} aria-pressed={!auto} onClick={()=>setAuto(v=>!v)}><Icon name={auto?'pause':'play'} size={16}/></button><span className="refresh-label">{auto?'每 5 秒刷新':'刷新已暂停'}</span><span className="topbar-divider"/><button className="icon-button" aria-label="刷新数据" onClick={()=>setEpoch(v=>v+1)}><Icon name="refresh" size={17} className={busy?'spinning':''}/></button></div></header><div className="content"><div className="page-heading"><div><h1>{pages.find(p=>p[0]===page)[2]}</h1><p>{selected?clientName(selected.client)+' · '+selected.raw_session.slice(0,8)+'…'+selected.raw_session.slice(-4)+' · '+selected.agent:'从一个明确的会话开始，查看记录并准备下一步。'}</p></div><div className="heading-actions">{data&&<span className="updated">更新于 {time(data.generated_at)}</span>}{page!=='handoff'&&data&&<button className="button primary" onClick={()=>setPage('handoff')}>整理交接<Icon name="arrow" size={16}/></button>}</div></div>
    {error&&<div className="error-banner" role="alert">{error} {data?'页面保留的是上次成功读取的数据。':''}</div>}
    {page==='help'?<Help bootstrap={bootstrap}/>:!data?<Empty bootstrap={bootstrap} selection={key} busy={busy} setPage={setPage}/>:page==='overview'?<><Metrics report={data.report}/><div className="overview-grid"><Trends data={data} minutes={minutes} setMinutes={setMinutes}/><Decision data={data} setPage={setPage}/></div><Requests key={key} data={data}/></>:page==='diagnostics'?<Diagnostics data={data}/>:<Handoff key={key} data={data} draft={drafts[key]??{}} onChange={changeField} onSeed={fields=>setDrafts(prev=>({...prev,[key]:fields}))}/>}
    <footer className="main-footer"><span>Context Guard</span><span>仅访问本机 · 缺失指标保留未知 · 不自动切换对话</span></footer></div></main></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
