export const fields=[['goal','当前目标与范围'],['completed','已完成与已验证'],['next','未完成与下一步'],['files','关键文件、分支与运行任务'],['constraints','约束、授权与应避免的失败路径']];
export const num=(n,digits=0)=>n==null?'—':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:digits}).format(n);
export const compact=n=>n==null?'—':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(n>=1e5?0:1)+'k':num(n,1);
export const bytes=n=>n==null?'—':n>=1073741824?(n/1073741824).toFixed(2)+' GiB':n>=1048576?(n/1048576).toFixed(1)+' MiB':n>=1024?(n/1024).toFixed(1)+' KiB':num(n)+' B';
export const duration=n=>n==null?'—':(n/1000).toFixed(1)+' s';
export const time=(n,full=false)=>n==null?'—':new Date(n).toLocaleString('zh-CN',full?{hour12:false}:{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
export const clientName=client=>({codex:'Codex',claude:'Claude Code',gemini:'Gemini CLI',grok:'Grok',generic:'自建 Agent'}[client]??client);
export function trafficLabel(t) {
  if(t.provider==='system_interface') return '网卡 '+t.interface+' · 所有程序';
  if(t.provider==='mihomo') return '本机代理 · 所有程序与会话';
  return '未接入流量来源';
}
export function makeHandoff(data,draft={}) {
  if(!data?.report) return '';
  const r=data.report,c=r.compactions,t=r.traffic;
  const task=fields.map(([key,label])=>'## '+label+'\n\n'+(draft[key]?.trim()||'未提供，请在交接前补充。')).join('\n\n');
  const speed=r.speed.status==='measured_request_end_to_end'?num(r.speed.recent_output_tokens_per_second,1)+' 输出 Token/s；为基线的 '+num(r.speed.ratio*100,1)+'%，含排队、网络、推理和生成。':'未知：没有足够的可比请求样本。';
  const traffic=t.status==='measured'||t.status==='stale'?trafficLabel(t)+'；采样 '+num(t.seconds/60,1)+' 分钟，上传 '+bytes(t.upload_bytes)+'，下载 '+bytes(t.download_bytes)+'；'+(t.status==='stale'?'已过期，仅作历史记录。':'最后采样距报告 '+num(t.freshness_seconds,1)+' 秒。'):'未知：未接入或有效采样不足。';
  return '# 会话交接摘要\n\n生成时间：'+time(data.generated_at,true)+'\n来源客户端：'+clientName(r.client)+'\n会话：'+r.external_session_id+'\n代理：'+r.agent+(r.source?'\n自定义来源：'+r.source:'')+'\n\n'+task+
    '\n\n## 监测记录与边界\n\n'+
    '- 压缩：已知完成 '+(c.known_total==null?'未知':num(c.known_total)+' 次')+'；接入后触发 '+num(c.triggered_since_activation)+' 次。覆盖：'+c.coverage+'。\n'+
    '- 客户端上下文占比：'+(r.context.used_percentage==null?'未知':num(r.context.used_percentage,1)+'%')+'。\n'+
    '- 最近输入 '+num(r.tokens.latest_input)+' Token（缓存读入 '+num(r.tokens.latest_cached_input)+'）；输出 '+num(r.tokens.latest_output)+'。来源：'+(r.tokens.latest_source??'未知')+'。快照不等于累计消耗。\n'+
    '- 已记录完成请求 '+num(r.tokens.completed_requests)+' 次；记录到的 Token 总计 '+num(r.tokens.recorded_total)+'，仅覆盖有数值的完成请求，包含重复及缓存输入，不等于订阅剩余额度。\n'+
    '- 有效请求速率：'+speed+'\n'+
    '- 流量：'+traffic+'不能全部归给当前窗口。\n'+
    '- 当前提醒：'+(r.alerts.length?r.alerts.map(a=>a.message).join(' '):'本次报告没有触发提醒；缺失指标仍为未知。')+'\n'+
    '- 新对话先核对实际文件和任务状态。阈值为试行策略，压缩次数不构成能力下降或限速的证明。\n';
}
