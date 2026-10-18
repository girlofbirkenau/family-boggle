'use strict';
const $ = s => document.querySelector(s);
let password = '', data;
async function api(path, body) {
  const response = await fetch('/api/admin/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+password,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const value = await response.json(); if(!response.ok) throw Error(value.error || 'Request failed'); return value;
}
const status = text => { $('#status').textContent=text; };
function options(select, items) { select.replaceChildren(...items.map(([value,label])=>{const o=document.createElement('option');o.value=value;o.textContent=label;return o;})); }
async function refresh() {
  data=await api('players'); const room=$('#room').value;
  options($('#room'),data.rooms.map(r=>[r.name,r.name])); if(data.rooms.some(r=>r.name===room)) $('#room').value=room;
  populate(); $('#tools').hidden=false; $('#login').hidden=true;
}
function populate() {
  const players=(data.rooms.find(r=>r.name===$('#room').value)?.players||[]).slice().sort((a,b)=>a.name.localeCompare(b.name));
  for(const id of ['source','target']) options($('#'+id),[['','Select player…'],...players.map(p=>[p.key,p.name])]); preview();
}
function preview() {
  $('#confirm').checked=false; $('#merge').disabled=true; $('#preview').replaceChildren();
  const players=data.rooms.find(r=>r.name===$('#room').value)?.players||[];
  const a=players.find(p=>p.key===$('#source').value),b=players.find(p=>p.key===$('#target').value);
  if(!a||!b||a===b) return;
  const table=document.createElement('table');
  const row=values=>{const tr=document.createElement('tr');for(const value of values){const td=document.createElement('td');td.textContent=value;tr.append(td);}table.append(tr);};
  row(['Stat',a.name,b.name,'After merge']);
  for(const [key,label] of [['games','Games'],['wins','Wins'],['points','Points'],['words','Words'],['bestScore','Best round'],['mostWords','Most words'],['bestStreak','Best streak']]) row([label,a[key]||0,b[key]||0,['games','wins','points','words'].includes(key)?(a[key]||0)+(b[key]||0):Math.max(a[key]||0,b[key]||0)]);
  row(['Longest word',a.longestWord||'—',b.longestWord||'—',(a.longestWord||'').length>(b.longestWord||'').length?a.longestWord:b.longestWord||'—']);
  $('#preview').append(table);
}
$('#auth').onsubmit=async e=>{e.preventDefault();password=$('#password').value;$('#password').value='';try{await refresh();status('');}catch(e){password='';status(e.message);}};
$('#room').onchange=populate; $('#source').onchange=preview; $('#target').onchange=preview;
$('#confirm').onchange=()=>{$('#merge').disabled=!$('#confirm').checked||!$('#preview').firstChild;};
$('#refresh').onclick=async()=>{try{await refresh();status('Players refreshed.');}catch(e){status(e.message);}};
$('#merge').onclick=async()=>{const body={room:$('#room').value,source:$('#source').value,target:$('#target').value,updatedAt:data.updatedAt};$('#merge').disabled=true;try{const result=await api('merge',body);await refresh();status('Merged into '+result.name+'. Original records archived.');}catch(e){$('#confirm').checked=false;status(e.message);}};
$('#lock').onclick=()=>{password='';data=null;$('#tools').hidden=true;$('#login').hidden=false;$('#preview').replaceChildren();status('Admin locked.');};

$('#backup').onclick=async()=>{try{const backup=await api('backup');const blob=new Blob([JSON.stringify(backup)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='family-boggle-backup-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('Backup download started. Keep a copy outside the server.');}catch(e){status(e.message);}};
