import React,{useEffect,useState,useRef} from 'react';
import {clientName,time,num} from './format.mjs';

const reasonText={invalid_settings:'配置格式需要修复，原文件已保留。',unsupported_config_file:'配置不是可安全修改的普通文件，原文件已保留。',hooks_disabled_by_user:'客户端已关闭 Hooks，向导保留了这个选择。',managed_file_modified:'监测程序存在本地修改，向导没有覆盖。',existing_managed_directory:'程序目录中已有其他内容，向导没有覆盖。',configuration_changed:'配置在检测后发生变化，请重新检测后接入。',runtime_probe_failed:'监测程序没有通过启动检查，已尝试恢复本次改动。',setup_in_progress:'另一次接入正在进行，请稍后刷新。',no_eligible_client:'没有可接入的客户端，请安装或启动客户端后重新检测。',receipt_modified:'备份清单发生变化，已停止恢复。'};
const errorText=code=>reasonText[code]??'暂时无法完成这一步，请查看接入结果与保留的备份。';
function networkLabel(network) {
  return ({not_configured:'等待接入客户端',disabled:'自动采样已关闭',existing_proxy:'沿用已有代理事件采样',detecting:'正在识别系统默认出口',sampling:'正在采样',retrying:'正在重试系统计数',needs_interface:'默认出口无法唯一确认',unavailable:'当前无法取得系统计数',stopped:'采样已停止',finished:'本次限时采样已结束'}[network?.status]??'等待连接');
}
export default function SetupPanel({bootstrap,onChanged}) {
  const [state,setState]=useState(bootstrap?.setup??null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[interfaces,setInterfaces]=useState([]),[chosen,setChosen]=useState('');
  const inFlight=useRef(false);
  useEffect(()=>{if(bootstrap?.setup&&!inFlight.current)setState(bootstrap.setup);},[bootstrap?.setup]);
  async function refresh() {
    setBusy(true);inFlight.current=true;
    try {const response=await fetch('/api/setup/scan'),data=await response.json();if(!response.ok)throw new Error();setState(data);setNotice('已重新检测本机客户端与配置。');onChanged();}
    catch {setNotice('无法重新检测，请确认接入向导进程仍在运行。');}finally {setBusy(false);inFlight.current=false;}
  }
  async function action(path,body) {
    setBusy(true);inFlight.current=true;setNotice('正在处理，请保留此页面。');
    try {
      const response=await fetch('/api/setup/'+path,{method:'POST',headers:{'content-type':'application/json','x-ctg-setup-token':state.token},body:JSON.stringify(body)}),data=await response.json();
      if(data.status)setState(data.status);
      if(!response.ok||!data.ok){setNotice(errorText(data.code)+(data.recovery?.skipped?.length?' 有文件在接入期间被修改，请核对备份。':''));return;}
      setNotice(path==='rollback'?'已恢复本次接入前的配置，监测记录仍保留。':path==='network'?'流量采样设置已更新。':'监测配置已准备好。请完成客户端要求的审核，再开始一次正常使用以确认事件。');onChanged();
    }catch {setNotice('连接中断，请重新检测并核对接入结果。');}finally {setBusy(false);inFlight.current=false;}
  }
  async function listInterfaces() {
    setBusy(true);try {const response=await fetch('/api/setup/interfaces'),data=await response.json();if(!response.ok)throw new Error();setInterfaces(data.interfaces);setNotice('请选择实际使用的一张网卡，不把物理网卡与 VPN/TUN 相加。');}
    catch {setNotice('系统尚未提供网卡列表；上下文指标仍可使用。');}finally {setBusy(false);}
  }
  if(!state?.plan)return <section className="panel setup-intro"><h2>从启动入口自动接入</h2><p>当前运行的是只读面板。首次安装时双击 Skill 文件夹里的对应启动入口，向导会识别环境、备份配置并自动打开面板。</p><div className="launcher-list"><span>Windows <code>Start-Context-Guard.cmd</code></span><span>macOS <code>Start-Context-Guard.command</code></span><span>Linux <code>start-context-guard.sh</code></span></div><p>也可让当前 Agent 运行 <code>node scripts/setup.mjs</code>。客户端自身的审核仍需正常完成。</p></section>;
  const plan=state.plan,receipt=state.receipt,network=state.network??{},configured=receipt?.status==='applied',clients=plan.clients??[],observations=state.observations??{};
  const connected=configured?clients.filter(c=>(observations[c.id]??0)>=(receipt?.created_at??Infinity)):[];
  return <><div className="setup-title"><div className="section-intro"><h2>{configured?'接入结果，清楚可查':'让监测接上你的工作环境'}</h2><p>检测系统与客户端，保留已有设置，把可用数据接到本地面板。</p></div><button className="button" disabled={busy} onClick={refresh}>重新检测</button></div>
    <div className="setup-steps" aria-label="接入进度"><div><span className="step-number">1</span><strong>环境已识别</strong><small>{({win32:'Windows',darwin:'macOS',linux:'Linux'}[plan.platform]??plan.platform)+' · Node '+plan.node_version}</small></div><div><span className={'step-number '+(configured?'done':'')}>2</span><strong>{configured?'监测配置已写入':'等待接入监测'}</strong><small>{configured?'已处理 '+num(receipt.clients.filter(c=>c.status!=='blocked').length)+' 个客户端':'自动备份并合并设置'}</small></div><div><span className={'step-number '+(connected.length?'done':'')}>3</span><strong>{connected.length?'已收到真实事件':'等待客户端确认'}</strong><small>{connected.length?num(connected.length)+' 个客户端已产生记录':'完成审核或重启，再正常使用一次'}</small></div></div>
    {notice&&<div className="setup-notice" role="status">{notice}</div>}
    {plan.runtime_error&&<div className="error-banner" role="alert">{errorText(plan.runtime_error)}</div>}
    <section className="panel setup-clients"><div className="panel-head"><div><h2>检测到的 AI 客户端</h2><p>配置完成和数据接通分别确认；已有状态栏、其他 Hook 和历史目录会保留。</p></div><button className="button primary" disabled={busy||!plan.can_apply} onClick={()=>action('apply',{plan_id:plan.id})}>{busy?'正在接入…':configured?'检查并补全接入':'一键接入监测'}</button></div>
      <div className="setup-client-list">{plan.detected.map(d=>{
        const client=clients.find(c=>c.id===d.id),seen=observations[d.id],received=configured&&(seen??0)>=(receipt?.created_at??Infinity),written=receipt?.clients.some(c=>c.id===d.id&&c.status!=='blocked')&&receipt.status==='applied';
        const label=!d.detected?'未检测到':client?.status==='blocked'?'需要处理':received?'已收到事件':written?'配置已就绪':'等待接入';
        return <article className={'setup-client '+(!d.detected?'absent':'')} key={d.id}><span className={'session-logo '+d.id}>{clientName(d.id).slice(0,1)}</span><div className="setup-client-info"><h3>{clientName(d.id)}</h3><p>{d.detected?'检测依据：'+d.reasons.join('、'):'安装或启动该客户端后，可以重新检测。'}</p>{client?.reason&&<p className="inline-reason">{errorText(client.reason)}</p>}{client?.notes?.map(note=><small key={note}>{note}</small>)}{written&&!received&&<small>{d.id==='codex'?'在客户端输入 /hooks，或打开设置中的 Hooks 完成审核。':'如客户端要求确认，请正常审核；必要时重启会话。'}</small>}{received&&<small>最近事件：{time(seen,true)}；各项指标仍取决于客户端实际能力。</small>}</div><span className={'setup-badge '+(received?'connected':client?.status==='blocked'?'blocked':'')}>{label}</span></article>;
      })}</div></section>
    <div className="setup-bottom"><section className="panel setup-network"><h2>网络流量采样</h2><div className="network-state"><span className={'dot '+(network.status==='sampling'?'green':'')}/>{networkLabel(network)}</div><p>{network.interface?'已选择 '+network.interface+'，覆盖该接口上的所有程序与会话。':'自动使用可确认的系统默认出口；已有代理事件采样会继续沿用。'}</p>{network.status==='sampling'&&<small>本次已采集 {num(network.samples)} 个样本，最晚于 {time(network.expires_at,true)} 结束。关闭向导服务后停止。</small>}<div className="setup-network-actions">{['sampling','retrying','detecting','existing_proxy'].includes(network.status)?<button className="button" disabled={busy||network.status==='existing_proxy'} onClick={()=>action('network',{enabled:false})}>{network.status==='existing_proxy'?'沿用已有配置':'停止自动采样'}</button>:<button className="button" disabled={busy||!configured} onClick={()=>action('network',{enabled:true})}>自动识别并采样</button>}<button className="text-button" disabled={busy||!configured||network.status==='existing_proxy'} onClick={listInterfaces}>选择其他网卡</button></div>{interfaces.length>0&&<div className="interface-picker"><label className="sr-only" htmlFor="network-interface">网卡名称</label><select id="network-interface" value={chosen} onChange={e=>setChosen(e.target.value)}><option value="">选择一张网卡</option>{interfaces.map(i=><option key={i.name}>{i.name}</option>)}</select><button className="button primary" disabled={busy||!chosen} onClick={()=>action('network',{enabled:true,interfaceName:chosen})}>开始采样</button></div>}</section>
    <section className="panel setup-backup"><h2>备份与恢复</h2><p>{receipt?'本次处理 '+num(receipt.changed_files)+' 个文件。恢复前会核对文件是否被后续修改，保留已产生的监测记录。':'接入前会保存原配置。已有内容发生并发变化时，会暂停合并并提示重新检测。'}</p>{receipt&&<><details><summary>查看备份位置</summary><code>{receipt.backup_dir}</code></details><button className="button" disabled={busy||receipt.status==='rolled_back'} onClick={()=>{if(window.confirm('恢复本次接入前的配置？已产生的监测记录会保留。'))action('rollback',{receipt_id:receipt.id});}}>恢复本次接入</button></>}</section></div>
  </>;
}
