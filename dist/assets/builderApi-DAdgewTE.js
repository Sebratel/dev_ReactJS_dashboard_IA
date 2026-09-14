import{c as o,f as r,A as d}from"./index-C9yHeJd0.js";/**
 * @license lucide-react v0.395.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const m=o("Check",[["path",{d:"M20 6 9 17l-5-5",key:"1gmf2c"}]]);/**
 * @license lucide-react v0.395.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const b=o("ExternalLink",[["path",{d:"M15 3h6v6",key:"1q9fwt"}],["path",{d:"M10 14 21 3",key:"gplh6r"}],["path",{d:"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",key:"a6xqqp"}]]);/**
 * @license lucide-react v0.395.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const g=o("Pencil",[["path",{d:"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",key:"1a8usu"}],["path",{d:"m15 5 4 4",key:"1mk7zo"}]]);/**
 * @license lucide-react v0.395.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const f=o("Search",[["circle",{cx:"11",cy:"11",r:"8",key:"4ej97u"}],["path",{d:"m21 21-4.3-4.3",key:"1qie3q"}]]);/**
 * @license lucide-react v0.395.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const D=o("Sparkles",[["path",{d:"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",key:"4pj2yx"}],["path",{d:"M20 3v4",key:"1olli1"}],["path",{d:"M22 5h-4",key:"1gvqau"}],["path",{d:"M4 17v2",key:"vumght"}],["path",{d:"M5 18H3",key:"zchphs"}]]),S=[{key:"decimal",label:"Número Decimal",group:"Número",kind:"number"},{key:"fixedDecimal",label:"Número decimal fixo",group:"Número",kind:"number"},{key:"wholeNumber",label:"Número Inteiro",group:"Número",kind:"number"},{key:"percentage",label:"Percentual",group:"Número",kind:"number"},{key:"dateTime",label:"Data/hora",group:"Data e hora",kind:"date"},{key:"date",label:"Data",group:"Data e hora",kind:"date"},{key:"time",label:"Hora",group:"Data e hora",kind:"date"},{key:"dateTimeTz",label:"Data/Hora/Fuso Horário",group:"Data e hora",kind:"date"},{key:"duration",label:"Duração",group:"Data e hora",kind:"number"},{key:"text",label:"Texto",group:"Outros",kind:"dimension"},{key:"boolean",label:"Verdadeiro/Falso",group:"Outros",kind:"dimension"},{key:"binary",label:"Binário",group:"Outros",kind:"dimension"}],w={dimension:"Texto/Categoria",date:"Data",number:"Número"};let n=[];function x(a){n=a}function N(){return n}function v(a){return n.find(e=>e.key===a)}async function i(a){let e=null;try{e=await a.json()}catch{}if(!a.ok){const t=e==null?void 0:e.error;throw a.status===503?new d(503,t||"Base ainda não materializada no backend."):new d(a.status,t||`Erro ${a.status} no servidor.`)}return e}async function T(a,e,t=1,s=50,c=[],l,u,k=[]){const p=await r("/api/widget-data",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({widget:a,tabFilters:e,page:t,pageSize:s,relations:c,tableSort:l??void 0,matrixSort:u??void 0,dashboardMeasures:k})});return(await i(p)).data}async function L(a,e){const t=await r("/api/field-values",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({source:a,field:e})});return(await i(t)).values}async function M(a){const e=await r(a?`/api/sources?folderId=${encodeURIComponent(a)}`:"/api/sources");return(await i(e)).sources}export{m as C,S as D,b as E,w as F,g as P,D as S,v as a,L as b,f as c,M as d,T as f,N as g,x as r};
