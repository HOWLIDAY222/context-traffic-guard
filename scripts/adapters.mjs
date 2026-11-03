// Client contracts are deliberately separate from storage and reminder policy.
export const CLIENTS = {
  codex: {compaction_completion:true, request_tokens:'hooks', request_timing:'hook_pair', reminders:'hook_context'},
  claude: {compaction_completion:true, request_tokens:'statusline_current_context', request_timing:null, reminders:'hook_context_or_statusline'},
  gemini: {compaction_completion:false, request_tokens:'optional_model_hooks', request_timing:'optional_finish_marker', reminders:'hook_context'},
  grok: {compaction_completion:true, request_tokens:null, request_timing:null, reminders:'statusline_or_explicit_report'},
  generic: {compaction_completion:true, request_tokens:'reported_events', request_timing:'reported_events', reminders:'caller_consumes_json'},
};
const id = value => {
  if(typeof value!=='string'||!value||value.length>200) throw new Error('explicit session id required');
  return value;
};
export function clientKey(client,source='custom') {
  if(!Object.hasOwn(CLIENTS,client)) throw new Error('unsupported client');
  if(client!=='generic') return client;
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(source)) throw new Error('invalid custom source');
  return 'generic.'+source;
}
export function sessionKey(client,session,source='custom') {
  id(session);
  const key=clientKey(client,source);
  // Preserve already-installed Codex state and historical imports.
  return client==='codex'?session:'ctg-v1:'+key+':'+Buffer.from(session).toString('base64url');
}
const text = value => typeof value==='string'?value.slice(0,200):undefined;
const identifier = value => value==null?undefined:id(value);
const numeric = value => typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;

export function statusSnapshot(client,raw,{session,source='custom'}={}) {
  if(!['claude','grok'].includes(client)) throw new Error('statusline client unsupported');
  const rawSession=session??raw.session_id??raw.sessionId;
  const window=raw.context_window??{}, usage=window.current_usage;
  let current=null;
  if(client==='claude'&&usage&&numeric(usage.input_tokens)!==null) {
    const parts=[usage.input_tokens,usage.cache_creation_input_tokens,usage.cache_read_input_tokens];
    // Missing cache components cannot silently become zero.
    if(parts.every(v=>numeric(v)!==null)) current={
      input_tokens:parts.reduce((a,b)=>a+b,0),output_tokens:numeric(usage.output_tokens),
      cached_input_tokens:numeric(usage.cache_read_input_tokens),
    };
  }
  const percent=numeric(window.used_percentage), size=numeric(window.context_window_size);
  return {
    client,source:client,raw_session:rawSession==null?null:id(rawSession),
    session_id:rawSession==null?null:sessionKey(client,rawSession,source),
    hook_event_name:'ContextSnapshot', model:text(raw.model?.id??raw.model?.display_name),
    token_usage:current,
    context:{used_percentage:percent!==null&&percent<=100?percent:null,window_tokens:size>0?size:null},
    // These are current-window values, NOT cumulative session consumption.
    context_input_tokens:client==='claude'?numeric(window.total_input_tokens):null,
    context_output_tokens:client==='claude'?numeric(window.total_output_tokens):null,
  };
}

export function normalizeEvent(client,raw,{session,source='custom'}={}) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new Error('event object required');
  clientKey(client,source);
  const rawSession=id(session??raw.session_id??raw.sessionId);
  const original=raw.hook_event_name??raw.hookEventName;
  const base={session_id:sessionKey(client,rawSession,source),raw_session:rawSession,client,source:client==='generic'?source:client,
    agent_id:identifier(raw.agent_id??raw.agentId),turn_id:identifier(raw.turn_id??raw.prompt_id),
    model:text(typeof raw.model==='string'?raw.model:raw.model?.id),
    reasoning_effort:text(raw.reasoning_effort??raw.effort?.level),
  };
  if(client==='generic') {
    if(raw.version!==1) throw new Error('generic event version 1 required');
    const names={'session.started':'SessionStart','compaction.started':'PreCompact',
      'compaction.completed':'ConfirmedCompact','compression.triggered':'CompressionTriggered',
      'request.started':'PreModelRequest','request.finished':'PostModelRequest',
      'context.snapshot':'ContextSnapshot','checkpoint':'Checkpoint'};
    if(!Object.hasOwn(names,raw.event)) throw new Error('unsupported generic event');
    if(raw.event.startsWith('request.')&&!identifier(raw.request_id)) throw new Error('generic requests require request_id');
    const status=['completed','failed','cancelled'].includes(raw.status)?raw.status:undefined;
    return {...base,hook_event_name:names[raw.event],request_id:identifier(raw.request_id),event_id:identifier(raw.event_id),
      token_usage:raw.usage,status,elapsed_ms:numeric(raw.elapsed_ms),
      error:['rate_limit','timeout','network'].includes(raw.error_category)?raw.error_category:undefined,
      context:{used_percentage:numeric(raw.context?.used_percentage),window_tokens:numeric(raw.context?.window_tokens)}};
  }
  if(client==='codex') return {...base,hook_event_name:original,request_id:text(raw.request_id),
    token_usage:raw.token_usage,status:raw.status,error:typeof raw.error==='string'?raw.error:undefined};
  if(client==='claude'||client==='grok') {
    const allowed=['SessionStart','SessionEnd','UserPromptSubmit','PostToolUse','Stop','StopFailure','PreCompact','PostCompact'];
    if(!allowed.includes(original)) return {...base,hook_event_name:'Observation'};
    // Lifecycle hooks do not expose a per-request token or timing contract.
    return {...base,hook_event_name:original};
  }
  const names={SessionStart:'SessionStart',SessionEnd:'SessionEnd',BeforeAgent:'UserPromptSubmit',
    AfterAgent:'Stop',AfterTool:'PostToolUse',PreCompress:'CompressionTriggered',
    BeforeModel:'PreModelRequest',AfterModel:'ModelChunk'};
  const response=raw.llm_response??{}, usage=response.usageMetadata??{};
  const output=numeric(usage.candidatesTokenCount), thoughts=numeric(usage.thoughtsTokenCount);
  const input=numeric(usage.promptTokenCount), toolInput=numeric(usage.toolUsePromptTokenCount);
  return {...base,hook_event_name:names[original]??'Observation',
    model:text(raw.llm_request?.model??base.model),
    token_usage:{input_tokens:input===null?null:input+(toolInput??0),output_tokens:output===null?null:output+(thoughts??0),
      cached_input_tokens:numeric(usage.cachedContentTokenCount),reasoning_output_tokens:thoughts,
      total_tokens:numeric(usage.totalTokenCount)},
    // A finish marker ends the generation window. Usage-only trailing chunks may update it.
    generation_finished:Array.isArray(response.candidates)&&response.candidates.length===1&&
      (raw.llm_request?.config?.candidateCount??1)===1&&
      (response.candidates[0].index??0)===0&&
      typeof response.candidates[0].finishReason==='string'&&!!response.candidates[0].finishReason&&
      response.candidates[0].finishReason!=='FINISH_REASON_UNSPECIFIED',
    timing_kind:'finish_marker',
  };
}

export function canRemind(client,original) {
  if(client==='grok') return false; // Grok ignores stdout from passive hooks.
  if(client==='claude') return ['UserPromptSubmit','PostToolUse','Stop','SessionStart'].includes(original);
  if(client==='gemini') return ['BeforeAgent','AfterTool','AfterAgent','SessionStart','PreCompress'].includes(original);
  if(client==='generic') return original==='checkpoint';
  return ['UserPromptSubmit','PostToolUse','PostCompact','Stop'].includes(original);
}
export function reminderOutput(client,original,message) {
  if(!message) return {};
  if(client==='generic') return {reminder:message};
  if(client==='grok') return {};
  if(client==='gemini') return ['BeforeAgent','AfterTool','SessionStart'].includes(original)?
    {hookSpecificOutput:{additionalContext:message}}:{systemMessage:message};
  if(['UserPromptSubmit','PostToolUse','SessionStart'].includes(original))
    return {hookSpecificOutput:{hookEventName:original,additionalContext:message}};
  return {systemMessage:message};
}
export function renderStatus(client,report,snapshot) {
  const pct=snapshot?.context?.used_percentage??report?.context?.used_percentage;
  const count=report?.compactions?.known_total;
  const parts=[client,pct==null?'ctx=?':'ctx='+Math.round(pct)+'%',count==null?'compacts=?':'compacts='+count];
  if(!snapshot?.session_id) parts.push('unbound');
  if(report?.alerts?.length||pct>=80) parts.push('handoff: review');
  return parts.join(' | ');
}
