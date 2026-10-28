/* NidusLab Finance — app (Supabase-backed). Accounting engine unchanged from v2; storage moved to Postgres. */
const DATA_START = '2026-10-01';            // all records before this date are purged
const END = '9999-12-31';
const DEFAULT_EMPLOYEES = ['Prima Islam', 'Rahim Uddin', 'Karim Ahmed'];
const EXPENSE_CATEGORIES = ['T-shirt / Merchandise','Printing','Food & Refreshment','Transport','Event','Marketing','Advertising','Office Supplies','Stationery','Courier & Delivery','Software & Subscription','Internet & Communication','Travel','Accommodation','Client Meeting','Campus Visit','Seminar','Training & Development','Miscellaneous'];
const CATEGORY_ACCOUNT = {
  'T-shirt / Merchandise':'5050','Printing':'5040','Food & Refreshment':'5030','Transport':'5020','Event':'5110',
  'Marketing':'5000','Advertising':'5010','Office Supplies':'5060','Stationery':'5060','Courier & Delivery':'5120',
  'Software & Subscription':'5070','Internet & Communication':'5080','Travel':'5090','Accommodation':'5100',
  'Client Meeting':'5130','Campus Visit':'5090','Seminar':'5110','Training & Development':'5140','Miscellaneous':'5150',
};
const METHODS = { CASH:'Cash', BANK_TRANSFER:'Bank Transfer', BKASH:'bKash', NAGAD:'Nagad', CARD:'Card', OTHER:'Other' };
const PAID_BY_LABEL = { COMPANY:'Company Fund', EMPLOYEE:'Employee' };
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ---------------------------------------------------------
   Chart of accounts
   --------------------------------------------------------- */
const CHART_OF_ACCOUNTS = [
  {code:'1000',name:'Cash in Hand',type:'ASSET'},
  {code:'1010',name:'Bank Account',type:'ASSET'},
  {code:'1020',name:'bKash / Mobile Wallet',type:'ASSET'},
  {code:'1030',name:'Accounts Receivable',type:'ASSET'},
  {code:'1050',name:'Employee Advance',type:'ASSET'},
  {code:'2010',name:'Employee Reimbursement Payable',type:'LIABILITY'},
  {code:'2020',name:'Loan Payable',type:'LIABILITY'},
  {code:'2030',name:'Tax / VAT Payable',type:'LIABILITY'},
  {code:'3000',name:"Owner's Capital / Company Fund",type:'EQUITY'},
  {code:'3010',name:'Retained Earnings',type:'EQUITY'},
  {code:'3020',name:"Owner's Drawings / Fund Returned",type:'EQUITY'},
  {code:'5000',name:'Marketing Expense',type:'EXPENSE'},
  {code:'5010',name:'Advertising Expense',type:'EXPENSE'},
  {code:'5020',name:'Transport Expense',type:'EXPENSE'},
  {code:'5030',name:'Food & Refreshment',type:'EXPENSE'},
  {code:'5040',name:'Printing Expense',type:'EXPENSE'},
  {code:'5050',name:'T-shirt / Merchandise',type:'EXPENSE'},
  {code:'5060',name:'Office Supplies',type:'EXPENSE'},
  {code:'5070',name:'Software & Subscription',type:'EXPENSE'},
  {code:'5080',name:'Internet & Communication',type:'EXPENSE'},
  {code:'5090',name:'Travel Expense',type:'EXPENSE'},
  {code:'5100',name:'Accommodation',type:'EXPENSE'},
  {code:'5110',name:'Event Expense',type:'EXPENSE'},
  {code:'5120',name:'Courier & Delivery',type:'EXPENSE'},
  {code:'5130',name:'Client Meeting',type:'EXPENSE'},
  {code:'5140',name:'Training & Development',type:'EXPENSE'},
  {code:'5150',name:'Miscellaneous Expense',type:'EXPENSE'},
];
function accountByCode(code){ return CHART_OF_ACCOUNTS.find(a => a.code === code) || {code, name:'Account '+code}; }
function cashAccountForMethod(method){
  switch(method){
    case 'BANK_TRANSFER': case 'CARD': return '1010';
    case 'BKASH': case 'NAGAD': return '1020';
    default: return '1000';
  }
}

/* ---------------------------------------------------------
   Small helpers
   --------------------------------------------------------- */
const pad = n => String(n).padStart(2,'0');
function ymd(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function todayStr(){ return ymd(new Date()); }               // LOCAL date (old version used UTC — wrong before 6am in Dhaka)
function addDays(s, n){ const [y,m,d] = s.split('-').map(Number); return ymd(new Date(y, m-1, d+n)); }
function formatDate(s){ if (!s) return '—'; const [y,m,d] = String(s).slice(0,10).split('-'); return `${d}-${MON[Number(m)-1]}-${y}`; }
function monthLabel(ym){ const [y,m] = ym.split('-').map(Number); return `${MONTH_NAMES[m-1]} ${y}`; }
function num(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round2(n){ return Math.round(n*100)/100; }
function sumBy(list, fn){ return round2(list.reduce((s,x)=>s+num(fn(x)),0)); }
function formatBDT(n){
  n = round2(num(n));
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString('en-US', {maximumFractionDigits: abs % 1 === 0 ? 0 : 2, minimumFractionDigits: abs % 1 === 0 ? 0 : 2});
  return (n < 0 ? '-' : '') + '৳' + formatted;
}
function esc(v){ return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function jsArg(v){ return esc(JSON.stringify(String(v ?? ''))); } // safe string argument inside onclick="..."
function uid(){ return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==='x'?r:(r&3|8)).toString(16); }); }
function byDateAsc(a,b){ return a.date.localeCompare(b.date) || (a.createdAt||0)-(b.createdAt||0); }
function byDateDesc(a,b){ return -byDateAsc(a,b); }

/* ---------------------------------------------------------
   Accounting engine (all derived)
   --------------------------------------------------------- */
function expCompany(e){ return e.paidBy === 'COMPANY' ? num(e.amount) : 0; }
function expEmployee(e){ return e.paidBy === 'EMPLOYEE' ? num(e.amount) : 0; }
function paidSum(e, asOf = END){ return sumBy((e.payments||[]).filter(p => p.date <= asOf), p => p.amount); }
/** Amount still owed to the employee for an expense as of a date. */
function dueOf(e, asOf = END){
  if (e.paidBy !== 'EMPLOYEE' || e.date > asOf) return 0;
  return round2(Math.max(num(e.amount) - paidSum(e, asOf), 0));
}
function employeeDue(e, asOf){ return e.paidBy === 'EMPLOYEE' ? dueOf(e, asOf) : 0; }
function employeeName(e){ return (e.employee || '').trim() || 'Unknown employee'; }

function expStatus(e){
  if (e.paidBy === 'COMPANY') return { key:'PAID', label:'Paid', cls:'badge-paid' };
  const due = dueOf(e), paid = paidSum(e);
  if (due <= 0) return { key:'SETTLED', label:'Reimbursed', cls:'badge-reimbursed' };
  if (paid > 0) return { key:'PARTIAL', label:'Partial', cls:'badge-partial' };
  return { key:'DUE', label:'Reimb. Due', cls:'badge-pending' };
}

/** Cash book: every movement of company cash (fund in/out, company-paid expense, reimbursement). */
function cashLedger(){
  const L = [];
  data.funds.forEach(f => L.push({
    id:'f_'+f.id, ref:f.id, kind:'FUND', date:f.date, createdAt:f.createdAt || 0, method:f.method,
    desc: f.type === 'IN' ? `Fund received${f.description ? ' — ' + f.description : ''}` : `Fund returned / withdrawn${f.description ? ' — ' + f.description : ''}`,
    inAmt: f.type === 'IN' ? num(f.amount) : 0, outAmt: f.type === 'OUT' ? num(f.amount) : 0,
  }));
  data.expenses.forEach(e => {
    if (e.paidBy === 'COMPANY') L.push({
      id:'e_'+e.id, ref:e.id, kind:'EXPENSE', date:e.date, createdAt:e.createdAt || 0, method:e.paymentMethod,
      desc:`Expense — ${e.category}${e.description ? ': ' + e.description : ''}`, inAmt:0, outAmt:num(e.amount),
    });
    (e.payments || []).forEach(p => L.push({
      id:'p_'+p.id, ref:e.id, kind:p.kind, date:p.date, createdAt:p.createdAt || 0, method:p.method,
      desc: `Reimbursed to ${employeeName(e)} — ${e.description || e.category}`,
      inAmt:0, outAmt:num(p.amount),
    }));
  });
  return L.sort(byDateAsc);
}
function cashBalance(asOf = END){ return sumBy(cashLedger().filter(t => t.date <= asOf), t => t.inAmt - t.outAmt); }

/** Every number for a period [from, to] (inclusive, YYYY-MM-DD). */
function computePeriod(from, to, label){
  const inR = d => d >= from && d <= to;
  const prev = addDays(from, -1);
  const expenses = data.expenses.filter(e => inR(e.date)).sort(byDateAsc);
  const fundsInList = data.funds.filter(f => f.type === 'IN' && inR(f.date)).sort(byDateAsc);
  const fundsOutList = data.funds.filter(f => f.type === 'OUT' && inR(f.date)).sort(byDateAsc);
  const pays = [];
  data.expenses.forEach(e => (e.payments || []).forEach(p => { if (inR(p.date)) pays.push({ ...p, expense:e }); }));
  pays.sort(byDateAsc);
  const reimbList = pays.filter(p => p.kind === 'REIMBURSE');

  const r = {
    from, to, label, expenses, fundsInList, fundsOutList, reimbList,
    openingCash: cashBalance(prev), closingCash: cashBalance(to),
    fundsIn: sumBy(fundsInList, f => f.amount), fundsOut: sumBy(fundsOutList, f => f.amount),
    totalExpenses: sumBy(expenses, e => e.amount),
    companyPaid: sumBy(expenses, expCompany), employeePaid: sumBy(expenses, expEmployee),
    reimbursed: sumBy(reimbList, p => p.amount),
    employeeOutstanding: sumBy(data.expenses, e => employeeDue(e, to)),
    openingEmployeeDue: sumBy(data.expenses, e => employeeDue(e, prev)),
  };
  r.cashOut = round2(r.companyPaid + r.reimbursed + r.fundsOut);

  // Cash book rows for the period, with running balance
  let bal = r.openingCash;
  r.cashRows = cashLedger().filter(t => inR(t.date)).map(t => { bal = round2(bal + t.inAmt - t.outAmt); return { ...t, balance: bal }; });

  // By category
  const cat = {};
  expenses.forEach(e => {
    const c = cat[e.category] || (cat[e.category] = { name:e.category, count:0, total:0, company:0, employee:0, items:[] });
    c.count++; c.total += num(e.amount); c.company += expCompany(e); c.employee += expEmployee(e); c.items.push(e);
  });
  r.byCategory = Object.values(cat).sort((a,b) => b.total - a.total);

  // By employee
  const empAll = data.expenses.filter(e => e.paidBy === 'EMPLOYEE');
  const empNames = [...new Set(empAll.map(employeeName))].sort();
  r.byEmployee = empNames.map(n => {
    const es = empAll.filter(e => employeeName(e) === n);
    return {
      name:n,
      opening: sumBy(es, e => employeeDue(e, prev)),
      paid: sumBy(es.filter(e => inR(e.date)), e => e.amount),
      reimbursed: sumBy(reimbList.filter(p => employeeName(p.expense) === n), p => p.amount),
      closing: sumBy(es, e => employeeDue(e, to)),
    };
  }).filter(x => x.opening || x.paid || x.reimbursed || x.closing);

  return r;
}

/** Double-entry journal for one expense, derived from its current state. */
function journalFor(e){
  const exp = e.accountCode || '5150';
  const entries = [];
  const credit = e.paidBy === 'COMPANY' ? cashAccountForMethod(e.paymentMethod) : '2010';
  entries.push({ date:e.date, memo:'Expense recorded', lines:[ { acc:exp, dr:num(e.amount), cr:0 }, { acc:credit, dr:0, cr:num(e.amount) } ] });
  (e.payments || []).forEach(p => entries.push({
    date:p.date, memo: 'Reimbursement paid to employee',
    lines:[ { acc:'2010', dr:num(p.amount), cr:0 }, { acc: cashAccountForMethod(p.method), dr:0, cr:num(p.amount) } ],
  }));
  return entries;
}
function accountLabelFor(e, code){
  if (code === e.accountCode && e.accountLabel) return e.accountLabel + ' (Others)';
  return accountByCode(code).name;
}

/* ---------------------------------------------------------
   Period (month) selection — shared by Dashboard, Expenses,
   Reimbursements and Company Funds.
   --------------------------------------------------------- */
let period = { ym: (todayStr() < DATA_START ? DATA_START : todayStr()).slice(0,7) }; // 'YYYY-MM' or 'ALL'
function periodRange(p = period){
  if (p.ym === 'ALL') return { from:DATA_START, to:END, label:'All Months', all:true };
  const [y,m] = p.ym.split('-').map(Number);
  return { from:`${p.ym}-01`, to: ymd(new Date(y, m, 0)), label: monthLabel(p.ym), all:false };
}
function availableMonths(){
  const start = DATA_START.slice(0,7);
  let last = todayStr().slice(0,7);
  const dates = [...data.expenses.map(e=>e.date), ...data.funds.map(f=>f.date)];
  data.expenses.forEach(e => (e.payments||[]).forEach(p => dates.push(p.date)));
  dates.forEach(d => { if (d && d.slice(0,7) > last) last = d.slice(0,7); });
  if (last < start) last = start;
  const out = [];
  let [y,m] = start.split('-').map(Number);
  while (`${y}-${pad(m)}` <= last){ out.push(`${y}-${pad(m)}`); m++; if (m > 12){ m = 1; y++; } }
  return out.reverse();
}
function setPeriod(v){ period.ym = v; animNext = true; render(); }
function shiftPeriod(delta){
  const months = availableMonths().slice().reverse(); // oldest → newest
  if (period.ym === 'ALL') return;
  const i = months.indexOf(period.ym);
  const j = Math.min(Math.max(i + delta, 0), months.length - 1);
  period.ym = months[j]; animNext = true; render();
}
function periodPicker(){
  const months = availableMonths();
  const isAll = period.ym === 'ALL';
  const atNewest = !isAll && months[0] === period.ym;
  const atOldest = !isAll && months[months.length-1] === period.ym;
  return `<div class="period-bar">
    <button class="btn sm outline" onclick="shiftPeriod(-1)" title="Previous month" ${isAll||atOldest?'disabled':''}>&lsaquo;</button>
    <select class="inp" id="period_select" onchange="setPeriod(this.value)">
      ${months.map(m => `<option value="${m}" ${m===period.ym?'selected':''}>${monthLabel(m)}</option>`).join('')}
      <option value="ALL" ${isAll?'selected':''}>All Months</option>
    </select>
    <button class="btn sm outline" onclick="shiftPeriod(1)" title="Next month" ${isAll||atNewest?'disabled':''}>&rsaquo;</button>
  </div>`;
}

let REPORT_CSS = '';
let REPORT_LOGO = 'assets/logo-navy-sm.png';

/* ---------------------------------------------------------
   Navigation
   --------------------------------------------------------- */
const ICONS = {
  dashboard: '<svg viewBox="0 0 20 20" fill="none"><rect x="2" y="2" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.6"/><rect x="11" y="2" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.6"/><rect x="2" y="11" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.6"/><rect x="11" y="11" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.6"/></svg>',
  expenses: '<svg viewBox="0 0 20 20" fill="none"><path d="M5 2.2h10v14.6l-2-1.2-1.5 1.2-1.5-1.2-1.5 1.2-1.5-1.2-2 1.2V2.2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7.3 6.8h5.4M7.3 9.6h5.4M7.3 12.4h3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  reimbursements: '<svg viewBox="0 0 20 20" fill="none"><circle cx="7" cy="7.5" r="4.2" stroke="currentColor" stroke-width="1.6"/><circle cx="13" cy="12.5" r="4.2" stroke="currentColor" stroke-width="1.6"/></svg>',
  summary: '<svg viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="14" height="14" rx="2.2" stroke="currentColor" stroke-width="1.6"/><path d="M6.5 7.6h7M6.5 10.4h7M6.5 13.2h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  accounts: '<svg viewBox="0 0 20 20" fill="none"><path d="M4.2 3.8c0-.9.7-1.6 1.6-1.6H16v13.6H5.8c-.9 0-1.6.7-1.6 1.6V3.8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M4.2 15.8c0-.9.7-1.6 1.6-1.6H16" stroke="currentColor" stroke-width="1.5"/></svg>',
  users: '<svg viewBox="0 0 20 20" fill="none"><circle cx="7.5" cy="7" r="2.8" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 16c.6-2.7 2.6-4 5-4s4.4 1.3 5 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="14" cy="8" r="2.2" stroke="currentColor" stroke-width="1.6"/><path d="M13.5 12.2c2.3-.2 4 .9 4.5 3.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  funds: '<svg viewBox="0 0 20 20" fill="none"><rect x="2.5" y="4" width="15" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 8h15M6 12h2M13 12h1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};
const NAV = [
  {id:'dashboard', label:'Dashboard', icon:ICONS.dashboard},
  {id:'expenses', label:'Expenses', icon:ICONS.expenses},
  {id:'companyFunds', label:'Company Funds', icon:ICONS.funds},
  {id:'reimbursements', label:'Reimbursements', icon:ICONS.reimbursements},
  {id:'summary', label:'Summary', icon:ICONS.summary},
  {id:'requests', label:'Requests', icon:ICONS.reimbursements, writer:true},
  {id:'users', label:'Users & Access', icon:ICONS.users, admin:true},
  {id:'mine', label:'My Expenses', icon:ICONS.expenses, emp:true},
  {id:'settings', label:'Settings', icon:ICONS.accounts, any:true},
];
let state = { currentTab: 'dashboard' };

function render(){
  if (!navVisible(NAV.find(n => n.id === state.currentTab))) state.currentTab = canWrite() ? 'dashboard' : 'mine';
  renderNav();
  document.getElementById('topDate').textContent = new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'});
  const c = document.getElementById('content');
  const t = state.currentTab;
  if (t === 'dashboard') c.innerHTML = renderDashboard();
  else if (t === 'expenses') c.innerHTML = renderExpenses();
  else if (t === 'reimbursements') c.innerHTML = renderReimbursements();
  else if (t === 'summary') c.innerHTML = renderSummary();
  else if (t === 'companyFunds') c.innerHTML = renderCompanyFunds();
  else if (t === 'accounts') c.innerHTML = renderAccounts();
  else if (t === 'users' && isAdmin()){ c.innerHTML = renderUsersShell(); loadUsersTab(); }
  else if (t === 'requests') c.innerHTML = renderRequests();
  else if (t === 'mine') c.innerHTML = renderMine();
  else if (t === 'settings'){ c.innerHTML = renderSettings(); applyAvatar(); }
  postRender();
}
function renderNav(){
  document.getElementById('navList').innerHTML = NAV.filter(navVisible).map((n, i) => `
    <div class="nav-item ${state.currentTab===n.id?'active':''}" style="--i:${i}" onclick="switchTab('${n.id}')">
      <span class="nav-icon">${n.icon}</span><span class="nav-label">${n.label}</span>${badgeFor(n)}
    </div>`).join('');
}
function switchTab(id){ state.currentTab = id; animNext = true; closeSidebar(); render(); window.scrollTo(0,0); }
function openSidebar(){ document.getElementById('sidebar').classList.add('open'); document.getElementById('overlayDim').classList.add('open'); }
function closeSidebar(){ document.getElementById('sidebar').classList.remove('open'); document.getElementById('overlayDim').classList.remove('open'); }

function asOfText(pr){ return pr.all ? 'as of today' : 'as of ' + formatDate(pr.to); }

/* ---------------------------------------------------------
   Dashboard (month-wise)
   --------------------------------------------------------- */
function renderDashboard(){
  const pr = periodRange();
  const r = computePeriod(pr.from, pr.to, pr.label);
  const cashNow = cashBalance();
  const maxVal = Math.max(1, ...r.byCategory.slice(0,6).map(c => c.total));
  const empPeriod = r.expenses.filter(e => e.paidBy === 'EMPLOYEE');
  const empTotal = sumBy(empPeriod, e => e.amount), empDue = sumBy(empPeriod, e => dueOf(e, pr.to));
  const settleRate = empTotal > 0 ? Math.round(((empTotal - empDue) / empTotal) * 100) : 100;

  const activity = [
    ...r.expenses.map(e => ({ date:e.date, createdAt:e.createdAt, tag:'Expense', label:`${esc(e.category)} — ${esc(e.description||'')}`, amount:-num(e.amount), cash: e.paidBy==='COMPANY', note: PAID_BY_LABEL[e.paidBy] + (e.paidBy==='EMPLOYEE'?' · '+esc(employeeName(e)):''), click:`showExpenseDetail('${e.id}')` })),
    ...r.fundsInList.map(f => ({ date:f.date, createdAt:f.createdAt, tag:'Fund In', cash:true, label:esc(f.description||'Fund received'), amount:num(f.amount), note:'Cash in', click:`switchTab('companyFunds')` })),
    ...r.fundsOutList.map(f => ({ date:f.date, createdAt:f.createdAt, tag:'Fund Out', cash:true, label:esc(f.description||'Fund returned'), amount:-num(f.amount), note:'Cash out', click:`switchTab('companyFunds')` })),
    ...r.reimbList.map(p => ({ date:p.date, createdAt:p.createdAt, tag:'Reimbursed', cash:true, label:`${esc(employeeName(p.expense))} — ${esc(p.expense.description||p.expense.category)}`, amount:-num(p.amount), note:'Cash out', click:`showExpenseDetail('${p.expense.id}')` })),
  ].sort(byDateDesc).slice(0,10);

  return `
    <div class="page-head">
      <div>
        <h1>NidusLab Financial Dashboard</h1>
        <p class="subtitle" style="margin-bottom:0;">Showing: <b>${pr.label}</b> · Books start from ${formatDate(DATA_START)}</p>
      </div>
      ${periodPicker()}
    </div>

    <div class="row" style="margin:16px 0 4px;">
      ${canWrite()?'<button class="btn" onclick="openExpenseModal()">+ Add Expense</button>':''}
      ${canWrite()?'<button class="btn success" onclick="openFundModal()">+ Add Money</button>':''}
    </div>

    <div class="kpi-grid">
      ${kpiCard({ label:'Cash in Hand (All Time)', value:cashNow, cls: cashNow<0?'negative':'positive', sub:'Company fund balance after all expenses &amp; payments', onclick:`switchTab('companyFunds')` })}
      ${kpiCard({ label:'Funds Received', value:r.fundsIn, cls:'info', sub:`Money received from company · ${pr.label}`, onclick:`showKpiHistory('fundsIn')` })}
      ${kpiCard({ label:'Total Expenses', value:r.totalExpenses, cls:'negative', sub:`Company ${formatBDT(r.companyPaid)} · Employee ${formatBDT(r.employeePaid)}`, onclick:`showKpiHistory('totalExpenses')` })}
      ${kpiCard({ label:'Company Paid', value:r.companyPaid, sub:'Expenses paid from company fund', onclick:`showKpiHistory('companyPaid')` })}
      ${kpiCard({ label:'Employee Paid', value:r.employeePaid, sub:'Paid by employees from own pocket', onclick:`showKpiHistory('employeePaid')` })}
      ${kpiCard({ label:'Total Reimbursed', value:r.reimbursed, cls:'positive', sub:'Paid back to employees', onclick:`showKpiHistory('reimbursed')` })}
      ${kpiCard({ label:'Employee Payable', value:r.employeeOutstanding, cls:'warning', sub:`Employee Outstanding · still owed to employees (${asOfText(pr)})`, onclick:`showKpiHistory('employeeDue')` })}
      ${ringCard({ label:'Settlement Rate', pct:settleRate, sub:'Employee-paid expenses already reimbursed' })}
    </div>
    <p class="subtitle" style="margin-top:-12px;">💡 Click any card to see how the number was calculated.</p>

    <div class="grid-2">
      <div class="card">
        <h3>Cash Flow — ${pr.label}</h3>
        ${cashFlowHtml(r)}
      </div>
      <div class="card">
        <h3>Expense by Category</h3>
        ${r.byCategory.length ? `<div class="bar-chart">
          ${r.byCategory.slice(0,6).map(c => `
            <div class="bar-col">
              <div class="bar-value">${formatBDT(c.total)}</div>
              <div class="bar" style="height:${Math.max(4,(c.total/maxVal)*100)}px;"></div>
              <div class="bar-label">${esc(c.name)}</div>
            </div>`).join('')}
        </div>` : '<div class="empty">No expenses in this period.</div>'}
      </div>
    </div>

    <div class="card">
      <h3>Recent Activity — ${pr.label}</h3>
      ${activity.length ? activity.map(a => `
        <div class="act-row" onclick="${a.click}">
          <div><span class="tag">${a.tag}</span> ${a.label} <span class="muted" style="font-size:11.5px;">· ${formatDate(a.date)} · ${a.note}</span></div>
          <div class="${!a.cash?'':a.amount>=0?'green':'red'}" style="white-space:nowrap;font-weight:600;">${a.cash?(a.amount>=0?'+':'−'):''}${formatBDT(Math.abs(a.amount))}</div>
        </div>`).join('') : '<div class="empty">No activity in this period yet.</div>'}
    </div>
  `;
}

function cashFlowHtml(r){
  const line = (l, v, sign, cls='') => `<div>${l}</div><div class="num ${cls}">${sign}${formatBDT(v)}</div>`;
  return `<div class="flow">
    ${line('Opening Cash Balance', r.openingCash, '')}
    ${line('Add: Funds Received', r.fundsIn, '+ ', 'green')}
    ${line('Less: Company-paid Expenses', r.companyPaid, '− ', 'red')}
    ${line('Less: Reimbursements to Employees', r.reimbursed, '− ', 'red')}
    ${r.fundsOut ? line('Less: Funds Returned / Withdrawn', r.fundsOut, '− ', 'red') : ''}
    <div class="tot">Closing Cash Balance</div><div class="tot num ${r.closingCash<0?'red':''}">${formatBDT(r.closingCash)}</div>
  </div>
  ${r.employeePaid ? `<p class="hint muted" style="font-size:11.5px;margin:12px 0 0;">Employee-paid expenses (${formatBDT(r.employeePaid)}) do not reduce cash until they are reimbursed.</p>` : ''}`;
}

/* ---------------------------------------------------------
   KPI history — what makes up each number
   --------------------------------------------------------- */
function buildKpiHistory(key){
  const pr = periodRange();
  const r = computePeriod(pr.from, pr.to, pr.label);
  const exRow = (e, amt, extra='') => ({ date:e.date, label:`${esc(e.category)} — ${esc(e.description||'')}${extra}`, amount:amt, click:`closeModal('historyModal');showExpenseDetail('${e.id}')` });
  const T = {
    fundsIn: { title:'Funds Received', note:`Money received from company in ${pr.label}.`, running:true,
      rows: r.fundsInList.map(f => ({ date:f.date, label:esc(f.description||'Fund received') + ` <span class="muted">(${METHODS[f.method]||f.method})</span>`, amount:num(f.amount) })) },
    totalExpenses: { title:'Total Expenses', note:`All expenses dated in ${pr.label} (paid by company or by employees).`, running:true,
      rows: r.expenses.map(e => exRow(e, num(e.amount), ` <span class="muted">· ${PAID_BY_LABEL[e.paidBy]}${e.paidBy==='EMPLOYEE'?' ('+esc(employeeName(e))+')':''}</span>`)) },
    companyPaid: { title:'Company Paid', note:'Expenses paid directly from the company fund — each one reduced Cash in Hand.', running:true,
      rows: r.expenses.filter(e => e.paidBy==='COMPANY').map(e => exRow(e, num(e.amount))) },
    employeePaid: { title:'Employee Paid', note:'Expenses employees paid from their own pocket — these become Employee Payable until reimbursed.', running:true,
      rows: r.expenses.filter(e => e.paidBy==='EMPLOYEE').map(e => exRow(e, num(e.amount), ` <span class="muted">· ${esc(employeeName(e))}</span>`)) },
    reimbursed: { title:'Total Reimbursed', note:`Reimbursement payments made to employees in ${pr.label} (paid from Cash in Hand).`, running:true,
      rows: r.reimbList.map(p => ({ date:p.date, label:`${esc(employeeName(p.expense))} — ${esc(p.expense.description||p.expense.category)} <span class="muted">(${METHODS[p.method]||p.method})</span>`, amount:num(p.amount), click:`closeModal('historyModal');showExpenseDetail('${p.expense.id}')` })) },
    employeeDue: { title:'Employee Payable (Outstanding)', note:`Still owed to employees ${asOfText(pr)}. Includes unpaid amounts carried forward from earlier months.`, running:true,
      rows: data.expenses.filter(e => employeeDue(e, pr.to) > 0).sort(byDateAsc).map(e => exRow(e, employeeDue(e, pr.to), ` <span class="muted">· owed to ${esc(employeeName(e))}</span>`)) },
  };
  return T[key];
}
function showKpiHistory(key){
  const h = buildKpiHistory(key);
  if (!h) return;
  let running = 0;
  const rowsHtml = h.rows.map(r => {
    running = round2(running + r.amount);
    return `<tr ${r.click?`style="cursor:pointer;" onclick="${r.click}"`:''}>
      <td style="white-space:nowrap;">${formatDate(r.date)}</td><td>${r.label}</td>
      <td class="num"><b>${formatBDT(r.amount)}</b></td><td class="num muted">${formatBDT(running)}</td></tr>`;
  }).join('');
  document.getElementById('historyContent').innerHTML = `
    <h2 style="margin-bottom:2px;">${h.title}</h2>
    <p class="subtitle">${h.note} Showing: <b>${periodRange().label}</b>.</p>
    <div style="overflow-x:auto;"><table>
      <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th class="num">Running Total</th></tr></thead>
      <tbody>${rowsHtml || `<tr><td colspan="4" class="empty">No records.</td></tr>`}
      ${h.rows.length ? `<tr class="total-row"><td colspan="2">Total</td><td class="num">${formatBDT(running)}</td><td></td></tr>` : ''}</tbody>
    </table></div>`;
  openModal('historyModal');
}

/* ---------------------------------------------------------
   Expenses (month-wise, grouped by month in "All Months")
   --------------------------------------------------------- */
function expenseRowHtml(e){
  const st = expStatus(e);
  const due = dueOf(e);
  const who = e.paidBy === 'EMPLOYEE' ? esc(employeeName(e)) : 'Company Fund';
  const click = `onclick="showExpenseDetail('${e.id}')"`;
  return `<tr>
    <td class="click" ${click} style="white-space:nowrap;">${formatDate(e.date)}</td>
    <td class="click" ${click}>${esc(e.category)}</td>
    <td class="click" ${click} style="max-width:220px;overflow:hidden;text-overflow:ellipsis;">${e.costFund?`<span class="tag">${esc(e.costFund)}</span> `:''}${esc(e.description||'—')}${e.photo?' 📎':''}</td>
    <td class="click" ${click}>${who}</td>
    <td class="click num" ${click}><b>${formatBDT(e.amount)}</b></td>
    <td class="click" ${click}><span class="badge-status ${st.cls}">${st.label}</span>${due>0?`<div class="amber" style="font-size:11.5px;margin-top:3px;">Due ${formatBDT(due)}</div>`:''}</td>
    <td><div class="row" style="gap:6px;flex-wrap:nowrap;">
      ${due>0 && canWrite() ? `<button class="btn sm" onclick="openPaymentModal('EXPENSE', '${e.id}')">Reimburse</button>` : ''}
      ${canWrite()?`<button class="btn sm outline" onclick="openEditExpense('${e.id}')">Edit</button>`:''}
      ${canWrite()?`<button class="btn sm danger" onclick="deleteExpense('${e.id}')">Delete</button>`:''}
    </div></td>
  </tr>`;
}
function renderExpenses(){
  const pr = periodRange();
  const r = computePeriod(pr.from, pr.to, pr.label);
  const list = [...r.expenses].sort(byDateDesc);
  let body = '';
  if (!list.length) body = `<tr><td colspan="7" class="empty">No expenses recorded for ${pr.label}.</td></tr>`;
  else if (pr.all){
    const groups = {};
    list.forEach(e => (groups[e.date.slice(0,7)] = groups[e.date.slice(0,7)] || []).push(e));
    body = Object.keys(groups).sort().reverse().map(ym => `
      <tr class="month-row"><td colspan="4">${monthLabel(ym)} · ${groups[ym].length} expense(s)</td><td class="num">${formatBDT(sumBy(groups[ym], e=>e.amount))}</td><td colspan="2"></td></tr>
      ${groups[ym].map(expenseRowHtml).join('')}`).join('');
  } else body = list.map(expenseRowHtml).join('');

  return `
    <div class="page-head">
      <div><h1>Expenses</h1><p class="subtitle" style="margin-bottom:0;">Showing: <b>${pr.label}</b> · click a row for full details &amp; journal entry.</p></div>
      <div class="actions">${periodPicker()}${canWrite()?'<button class="btn" onclick="openExpenseModal()">+ Add Expense</button>':''}</div>
    </div>
    <div class="kpi-grid">
      ${kpiCard({ label:'Total Expenses', value:r.totalExpenses, cls:'negative', sub:`${r.expenses.length} expense(s)` })}
      ${kpiCard({ label:'Company Paid', value:r.companyPaid, sub:'From company fund' })}
      ${kpiCard({ label:'Employee Paid', value:r.employeePaid, sub:'From own pocket' })}
    </div>
    ${fundSummaryHtml(r.expenses)}
    <div class="card" style="padding:0;overflow-x:auto;">
      <table>
        <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Paid By</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>${body}
          ${list.length ? `<tr class="total-row"><td colspan="4">Total — ${pr.label}</td><td class="num">${formatBDT(r.totalExpenses)}</td><td colspan="2"></td></tr>` : ''}
        </tbody>
      </table>
    </div>`;
}

/* ---------------------------------------------------------
   Reimbursements (Employee Payable)
   --------------------------------------------------------- */
function renderReimbursements(){
  const pr = periodRange();
  const r = computePeriod(pr.from, pr.to, pr.label);
  const prev = addDays(pr.from, -1);
  const rows = data.expenses.filter(e => e.paidBy === 'EMPLOYEE')
    .map(e => ({ e, carried: e.date < pr.from && employeeDue(e, prev) > 0, inPeriod: e.date >= pr.from && e.date <= pr.to }))
    .filter(x => x.inPeriod || x.carried)
    .sort((a,b) => byDateAsc(a.e,b.e));

  return `
    <div class="page-head">
      <div><h1>Reimbursements</h1><p class="subtitle" style="margin-bottom:0;">Employee Payable — money employees spent from their own pocket. Showing: <b>${pr.label}</b>.</p></div>
      <div class="actions">${periodPicker()}</div>
    </div>
    <div class="kpi-grid">
      ${!pr.all ? kpiCard({ label:'Opening Payable', value:r.openingEmployeeDue, cls:'warning', sub:'Carried from earlier months' }) : ''}
      ${kpiCard({ label:'Employee Paid', value:r.employeePaid, sub:`Submitted in ${pr.label}` })}
      ${kpiCard({ label:'Total Reimbursed', value:r.reimbursed, cls:'positive', sub:`Paid back in ${pr.label}` })}
      ${kpiCard({ label:'Employee Payable', value:r.employeeOutstanding, cls:'warning', sub:`Still owed, ${asOfText(pr)}` })}
    </div>

    <div class="card" style="padding:0;overflow-x:auto;">
      <div style="padding:16px 20px 4px;"><h3 style="margin:0;">By Employee</h3></div>
      <table>
        <thead><tr><th>Employee</th>${!pr.all?'<th class="num">Opening Due</th>':''}<th class="num">Paid (own pocket)</th><th class="num">Reimbursed</th><th class="num">Closing Due</th><th></th></tr></thead>
        <tbody>${r.byEmployee.length ? r.byEmployee.map(x => {
          const dueNow = sumBy(data.expenses.filter(e => e.paidBy==='EMPLOYEE' && employeeName(e)===x.name), e => employeeDue(e));
          return `<tr><td><b>${esc(x.name)}</b></td>${!pr.all?`<td class="num">${formatBDT(x.opening)}</td>`:''}<td class="num">${formatBDT(x.paid)}</td><td class="num green">${formatBDT(x.reimbursed)}</td><td class="num ${x.closing>0?'amber':'green'}">${formatBDT(x.closing)}</td>
            <td>${dueNow>0?(canWrite()?`<button class="btn sm" onclick="openPaymentModal('EMPLOYEE', ${jsArg(x.name)})">Pay ${formatBDT(dueNow)}</button>`:'<span class="amber" style="font-size:12px;">Due</span>'):'<span class="muted" style="font-size:12px;">Settled</span>'}</td></tr>`;
        }).join('') : `<tr><td colspan="6" class="empty">No employee-paid expenses for this period.</td></tr>`}</tbody>
      </table>
    </div>

    <div class="card" style="padding:0;overflow-x:auto;">
      <div style="padding:16px 20px 4px;"><h3 style="margin:0;">Expense-wise Detail</h3></div>
      <table>
        <thead><tr><th>Date</th><th>Employee</th><th>Description</th><th class="num">Paid</th><th class="num">Reimbursed</th><th class="num">Outstanding</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(({e, carried}) => {
          const st = expStatus(e); const due = dueOf(e);
          return `<tr${carried?' style="background:var(--amber-bg);"':''}>
            <td style="white-space:nowrap;">${formatDate(e.date)}${carried?'<div><span class="tag" title="Not cleared before this month — carried forward">Carried fwd</span></div>':''}</td>
            <td>${esc(employeeName(e))}</td>
            <td class="click" onclick="showExpenseDetail('${e.id}')" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;">${esc(e.description||e.category)}</td>
            <td class="num">${formatBDT(e.amount)}</td><td class="num green">${formatBDT(paidSum(e))}</td><td class="num amber">${formatBDT(due)}</td>
            <td><span class="badge-status ${st.cls}">${st.label}</span></td>
            <td><div class="row" style="gap:6px;flex-wrap:nowrap;">
              ${due>0&&canWrite()?`<button class="btn sm" onclick="openPaymentModal('EXPENSE', '${e.id}')">Reimburse</button>`:''}
              <button class="btn sm outline" onclick="showExpenseDetail('${e.id}')">View</button>
            </div></td></tr>`;
        }).join('') : `<tr><td colspan="8" class="empty">Nothing to show for this period.</td></tr>`}</tbody>
      </table>
    </div>`;
}

/* ---------------------------------------------------------
   Company Funds — Cash Book
   --------------------------------------------------------- */
const KIND_TAG = { FUND:'Fund', EXPENSE:'Expense', REIMBURSE:'Reimbursement' };
function renderCompanyFunds(){
  const pr = periodRange();
  const r = computePeriod(pr.from, pr.to, pr.label);
  const cashNow = cashBalance();
  const rows = [...r.cashRows].reverse();
  return `
    <div class="page-head">
      <div><h1>Company Funds — Cash Book</h1><p class="subtitle" style="margin-bottom:0;">Every taka in and out of the company fund. Company-paid expenses and reimbursements are deducted automatically (<span class="tag">Auto</span>). Showing: <b>${pr.label}</b>.</p></div>
      <div class="actions">${periodPicker()}${canWrite()?'<button class="btn success" onclick="openFundModal()">+ Add Money</button>':''}</div>
    </div>
    <div class="kpi-grid">
      ${kpiCard({ label:'Cash in Hand (All Time)', value:cashNow, cls: cashNow<0?'negative':'positive', sub:'Current company fund balance' })}
      ${!pr.all ? kpiCard({ label:'Opening Balance', value:r.openingCash, cls:'info', sub:`On ${formatDate(pr.from)}` }) : ''}
      ${kpiCard({ label:'Cash In', value:r.fundsIn, cls:'positive', sub:'Funds received' })}
      ${kpiCard({ label:'Cash Out', value:r.cashOut, cls:'negative', sub:'Company-paid expenses + reimbursements' })}
      ${!pr.all ? kpiCard({ label:'Closing Balance', value:r.closingCash, cls: r.closingCash<0?'negative':'', sub:`On ${formatDate(pr.to)}` }) : ''}
    </div>
    <div class="card" style="padding:0;overflow-x:auto;">
      <table>
        <thead><tr><th>Date</th><th>Description</th><th>Type</th><th>Method</th><th class="num">Cash In</th><th class="num">Cash Out</th><th class="num">Balance</th><th></th></tr></thead>
        <tbody>
          ${rows.map(t => `<tr>
            <td style="white-space:nowrap;">${formatDate(t.date)}</td>
            <td>${esc(t.desc)}${t.kind!=='FUND'?' <span class="tag">Auto</span>':''}</td>
            <td><span class="muted" style="font-size:12px;">${KIND_TAG[t.kind]}</span></td>
            <td><span class="muted" style="font-size:12px;">${METHODS[t.method]||t.method||'—'}</span></td>
            <td class="num green">${t.inAmt?formatBDT(t.inAmt):'—'}</td>
            <td class="num red">${t.outAmt?formatBDT(t.outAmt):'—'}</td>
            <td class="num ${t.balance<0?'red':''}"><b>${formatBDT(t.balance)}</b></td>
            <td>${t.kind==='FUND' ? (canWrite() ? `<button class="btn sm danger" onclick="deleteFund('${t.ref}')">Delete</button>` : '') : `<button class="btn sm outline" onclick="showExpenseDetail('${t.ref}')">View</button>`}</td>
          </tr>`).join('')}
          ${!pr.all ? `<tr class="total-row"><td>${formatDate(pr.from)}</td><td colspan="5">Opening balance (brought forward)</td><td class="num">${formatBDT(r.openingCash)}</td><td></td></tr>` : ''}
          ${!rows.length && pr.all ? '<tr><td colspan="8" class="empty">No fund transactions yet. Click "+ Add Money" to record money received from the company.</td></tr>' : ''}
        </tbody>
      </table>
    </div>`;
}

/* ---------------------------------------------------------
   Chart of accounts
   --------------------------------------------------------- */
function renderAccounts(){
  const groups = ['ASSET','LIABILITY','EQUITY','EXPENSE'];
  const titles = {ASSET:'Assets', LIABILITY:'Liabilities', EQUITY:'Equity', EXPENSE:'Expenses'};
  return `
    <h1>Chart of Accounts</h1>
    <p class="subtitle">Ledger accounts used by the double-entry journal behind every transaction.</p>
    <div class="card">
      ${groups.map(g => `
        <div class="accounts-section-title">${titles[g]}</div>
        <table style="margin-bottom:10px;"><tbody>
          ${CHART_OF_ACCOUNTS.filter(a=>a.type===g).map(a=>`<tr><td style="width:70px;"><b>${a.code}</b></td><td>${a.name}</td></tr>`).join('')}
        </tbody></table>`).join('')}
    </div>`;
}

/* ---------------------------------------------------------
   Modal helpers
   --------------------------------------------------------- */
function openModal(id){ document.getElementById(id).classList.add('open'); }
function closeModal(id){ document.getElementById(id).classList.remove('open'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open')); });
function methodOptions(selected){ return Object.entries(METHODS).map(([k,v]) => `<option value="${k}" ${k===selected?'selected':''}>${v}</option>`).join(''); }
function confirmCash(amountOut, date){
  const after = round2(cashBalance() - amountOut);
  if (after >= 0) return true;
  return confirm(`Cash in Hand is ${formatBDT(cashBalance())}. This payment of ${formatBDT(amountOut)} will make it ${formatBDT(after)} (negative).\n\nAdd money first with "+ Add Money", or press OK to save anyway.`);
}

/* ---------------------------------------------------------
   Add / Edit Expense
   --------------------------------------------------------- */
function getPaidBy(){ return document.querySelector('input[name="exp_paidby"]:checked').value; }
function openExpenseModal(paidBy){
  prepExpenseModal();
  if (paidBy) { document.querySelector(`input[name="exp_paidby"][value="${paidBy}"]`).checked = true; togglePaidBy(); }
  openModal('expenseModal');
}
function prepExpenseModal(){
  document.getElementById('exp_editing_id').value = '';
  document.getElementById('expenseModalTitle').textContent = 'Add Expense';
  document.getElementById('expenseSaveBtn').textContent = 'Save Expense';
  const dateEl = document.getElementById('exp_date');
  dateEl.min = DATA_START; dateEl.value = todayStr() < DATA_START ? DATA_START : todayStr();
  document.getElementById('exp_category').innerHTML = EXPENSE_CATEGORIES.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('') + `<option value="OTHERS">Others</option>`;
  document.getElementById('exp_method').innerHTML = methodOptions('CASH');
  refreshEmployeeDropdown();
  setCostFundFor(null);
  ['exp_description','exp_amount','exp_notes','exp_category_other','exp_photo'].forEach(id => document.getElementById(id).value = '');
  ['exp_photo_preview','exp_photo_filename','exp_photo_remove','exp_employee_field','exp_category_other_field'].forEach(id => document.getElementById(id).classList.add('hidden'));
  document.querySelector('input[name="exp_paidby"][value="COMPANY"]').checked = true;
  window._expPhotoFile = null; window._expPhotoKeep = null;
  onCategoryChange();
  togglePaidBy();
  applyRoleToExpenseModal();
}
function openEditExpense(id){
  const e = data.expenses.find(x => x.id === id);
  if (!e) return;
  closeModal('detailModal');
  prepExpenseModal();
  document.getElementById('exp_editing_id').value = id;
  document.getElementById('expenseModalTitle').textContent = 'Edit Expense';
  document.getElementById('expenseSaveBtn').textContent = 'Save Changes';
  document.getElementById('exp_date').value = e.date;
  document.getElementById('exp_description').value = e.description || '';
  document.getElementById('exp_amount').value = e.amount;
  document.getElementById('exp_notes').value = e.notes || '';
  document.getElementById('exp_method').value = e.paymentMethod || 'CASH';
  const catSelect = document.getElementById('exp_category');
  if ([...catSelect.options].some(o => o.value === e.category)) catSelect.value = e.category;
  else { catSelect.value = 'OTHERS'; document.getElementById('exp_category_other').value = e.category; document.getElementById('exp_category_other_field').classList.remove('hidden'); }
  document.querySelector(`input[name="exp_paidby"][value="${e.paidBy}"]`).checked = true;
  if (e.paidBy === 'EMPLOYEE'){
    if (e.employee && !data.employees.includes(e.employee)) { data.employees.push(e.employee); saveData(); }
    refreshEmployeeDropdown(e.employee);
  }
  if (e.photo || e.photoPath){
    window._expPhotoKeep = { path:e.photoPath, name:e.photoName, mime:e.photoMime, url:e.photo };
    showPhotoPreview(e.photo, e.photoName, isImageFile(e));
  }
  setCostFundFor(e);
  togglePaidBy();
  openModal('expenseModal');
}
function onCategoryChange(){
  const v = document.getElementById('exp_category').value;
  document.getElementById('exp_category_other_field').classList.toggle('hidden', v !== 'OTHERS');
}
function togglePaidBy(){
  const p = getPaidBy();
  document.getElementById('exp_employee_field').classList.toggle('hidden', p !== 'EMPLOYEE');
  updateExpensePreview();
}
function showPhotoPreview(src, name, isImage){
  const img = document.getElementById('exp_photo_preview');
  const fn = document.getElementById('exp_photo_filename');
  if (isImage && src){ img.src = src; img.classList.remove('hidden'); fn.classList.add('hidden'); }
  else { img.classList.add('hidden'); fn.textContent = 'Attached file: ' + (name || 'file'); fn.classList.remove('hidden'); }
  document.getElementById('exp_photo_remove').classList.remove('hidden');
}
function previewExpensePhoto(ev){
  const file = ev.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024){ alert('File is larger than 10 MB. Please attach a smaller file.'); ev.target.value=''; return; }
  window._expPhotoFile = file;
  showPhotoPreview(URL.createObjectURL(file), file.name, String(file.type).startsWith('image/'));
}
function removeExpensePhoto(){
  window._expPhotoFile = null; window._expPhotoKeep = null;
  document.getElementById('exp_photo').value = '';
  ['exp_photo_preview','exp_photo_filename','exp_photo_remove'].forEach(id => document.getElementById(id).classList.add('hidden'));
}
function updateExpensePreview(){
  const amount = num(document.getElementById('exp_amount').value);
  const p = getPaidBy();
  const box = document.getElementById('exp_calc_preview');
  if (amount <= 0){ box.innerHTML = '<span class="muted">Enter an amount to see how it affects the books.</span>'; return; }
  const editingId = document.getElementById('exp_editing_id').value;
  const old = editingId ? data.expenses.find(x => x.id === editingId) : null;
  const cashNow = cashBalance();
  let html = `<div><b>Effect on the books:</b></div><div>Total Expenses: <b>+${formatBDT(amount)}</b></div>`;
  if (p === 'COMPANY'){
    const adj = old && old.paidBy === 'COMPANY' ? num(old.amount) : 0;
    const after = round2(cashNow + adj - amount);
    html += `<div>Company Paid: <b>+${formatBDT(amount)}</b></div><div>Cash in Hand: ${formatBDT(cashNow)} → <b class="${after<0?'red':''}">${formatBDT(after)}</b></div>`;
    if (after < 0) html += `<div class="warn-box">Cash in Hand ${formatBDT(cashNow + adj)}. Short by <b>${formatBDT(-after)}</b> — cannot save. Add the ${formatBDT(-after)} as a separate "Employee (Own Pocket)" expense, or add money first.</div>`;
  } else if (!canWrite()){
    html = `<div><b>Request to admin:</b> ${formatBDT(amount)}</div><div class="muted">After approval you get ${formatBDT(amount)} back as reimbursement.</div>`;
  } else {
    const emp = document.getElementById('exp_employee').value || 'employee';
    html += `<div>Employee Paid: <b>+${formatBDT(amount)}</b> (${esc(emp)})</div><div>Employee Payable: <b>+${formatBDT(amount)}</b> — ${esc(emp)} will get this back when reimbursed.</div><div class="muted">Cash in Hand does not change now (${formatBDT(cashNow)}).</div>`;
  }
  box.innerHTML = html;
}
function saveExpense(){
  const date = document.getElementById('exp_date').value;
  let category = document.getElementById('exp_category').value;
  const description = document.getElementById('exp_description').value.trim();
  const amount = round2(num(document.getElementById('exp_amount').value));
  const paidBy = getPaidBy();
  const paymentMethod = document.getElementById('exp_method').value;
  const employee = document.getElementById('exp_employee').value;
  const notes = document.getElementById('exp_notes').value.trim();
  const costFund = getCostFund();

  if (category === 'OTHERS'){
    const custom = document.getElementById('exp_category_other').value.trim();
    if (!custom){ alert('Please specify the "Others" category.'); return; }
    category = custom;
  }
  if (!date || amount <= 0){ alert('Please enter a date and an amount greater than zero.'); return; }
  if (date < DATA_START){ alert(`Books start on ${formatDate(DATA_START)}. Please choose a date on or after that.`); return; }
  if (!costFund){ alert('Please choose a Cost Fund (NidusTime / NidusJob / NidusLab / Others).'); return; }
  if (paidBy === 'EMPLOYEE' && !employee){ alert('Please select which employee paid.'); return; }

  const editingId = document.getElementById('exp_editing_id').value;
  const accountCode = CATEGORY_ACCOUNT[category] || '5150'; // ledger account is picked automatically from the category
  const fields = { date, category, accountCode, accountLabel:null, description, amount, paidBy, paymentMethod,
    employee: paidBy === 'EMPLOYEE' ? employee : null, notes, costFund, ...photoFields() };

  if (!canWrite()){
    if (editingId) return;
    data.mine.push({ id:uid(), createdAt:Date.now(), payments:[], status:'PENDING', ...fields, paidBy:'EMPLOYEE', employee:me.name });
    saveData(); closeModal('expenseModal'); toast('Request sent to admin.'); render(); return;
  }
  if (editingId){
    const e = data.expenses.find(x => x.id === editingId);
    if (!e) return;
    let payments = e.payments || [];
    const kindNeeded = paidBy === 'EMPLOYEE' ? 'REIMBURSE' : null;
    const sameParty = paidBy !== e.paidBy ? false : paidBy === 'EMPLOYEE' ? employee === e.employee : true;
    if (payments.length && (!kindNeeded || !sameParty || payments.some(p => p.kind !== kindNeeded))){
      if (!confirm(`This expense already has ${formatBDT(paidSum(e))} paid back (${payments.length} payment(s)). Changing "Paid By" will delete those payment records and put that money back into Cash in Hand. Continue?`)) return;
      payments = [];
    }
    const paid = sumBy(payments, p => p.amount);
    if (amount < paid){ alert(`Amount cannot be less than what has already been paid back (${formatBDT(paid)}). Delete a payment from the expense details first.`); return; }
    if (payments.some(p => p.date < date)){ alert('Some payments are dated before the new expense date. Please check the date.'); return; }
    // Cash needed by this edit = new company-paid amount − old company-paid amount − payments being undone
    const freed = (e.paidBy === 'COMPANY' ? num(e.amount) : 0) + (payments.length ? 0 : paidSum(e));
    const extra = round2((paidBy === 'COMPANY' ? amount : 0) - freed);
    if (extra > 0 && !checkCashOrBlock(extra)) return;
    Object.assign(e, fields, { payments });
  } else {
    if (paidBy === 'COMPANY' && !checkCashOrBlock(amount)) return;
    data.expenses.push({ id:uid(), createdAt:Date.now(), payments:[], status:'APPROVED', ...fields });
  }
  saveData();
  closeModal('expenseModal');
  render();
}
function deleteExpense(id){
  const e = data.expenses.find(x => x.id === id);
  if (!e) return;
  const paid = paidSum(e);
  const warn = paid > 0 ? `\n\n${formatBDT(paid)} has already been paid against it — those payment records will be deleted too and the money goes back to Cash in Hand.` : '';
  if (!confirm(`Delete this expense — "${e.description || e.category}" (${formatBDT(e.amount)})? This cannot be undone.${warn}`)) return;
  data.expenses = data.expenses.filter(x => x.id !== id);
  saveData(); closeModal('detailModal'); render();
}

/* ---------------------------------------------------------
   Add Money (fund received / returned)
   --------------------------------------------------------- */
function employeesWithDue(){
  const map = {};
  data.expenses.forEach(e => { const d = employeeDue(e); if (d > 0) map[employeeName(e)] = round2((map[employeeName(e)]||0) + d); });
  return map;
}
function openFundModal(){
  document.querySelector('input[name="fund_type"][value="IN"]').checked = true;
  const dateEl = document.getElementById('fund_date');
  dateEl.min = DATA_START; dateEl.value = todayStr() < DATA_START ? DATA_START : todayStr();
  document.getElementById('fund_amount').value = '';
  document.getElementById('fund_description').value = 'Company';
  document.getElementById('fund_method').innerHTML = methodOptions('CASH');
  const dues = employeesWithDue();
  const names = Object.keys(dues);
  document.getElementById('fund_settle').checked = false;
  document.getElementById('fund_settle_employee').innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n)} — due ${formatBDT(dues[n])}</option>`).join('');
  document.getElementById('fund_settle_box').classList.toggle('hidden', !names.length);
  document.getElementById('fund_settle_amount').value = '';
  updateFundPreview();
  openModal('fundModal');
}
function onFundSettleEmployee(){
  const dues = employeesWithDue();
  const emp = document.getElementById('fund_settle_employee').value;
  const amount = num(document.getElementById('fund_amount').value);
  document.getElementById('fund_settle_amount').value = round2(amount > 0 ? Math.min(dues[emp]||0, amount) : (dues[emp]||0));
  updateFundPreview();
}
function updateFundPreview(){
  const type = document.querySelector('input[name="fund_type"]:checked').value;
  const amount = num(document.getElementById('fund_amount').value);
  const box = document.getElementById('fund_preview');
  const hasDues = Object.keys(employeesWithDue()).length > 0;
  document.getElementById('fund_settle_box').classList.toggle('hidden', type !== 'IN' || !hasDues);
  const settle = type === 'IN' && hasDues && document.getElementById('fund_settle').checked;
  document.getElementById('fund_settle_fields').classList.toggle('hidden', !settle);
  if (settle && !document.getElementById('fund_settle_amount').value) onFundSettleEmployee();
  const settleAmt = settle ? num(document.getElementById('fund_settle_amount').value) : 0;
  const cashNow = cashBalance();
  if (amount <= 0){ box.innerHTML = `<span class="muted">Current Cash in Hand: <b>${formatBDT(cashNow)}</b></span>`; return; }
  const after = round2(cashNow + (type === 'IN' ? amount : -amount) - settleAmt);
  box.innerHTML = `
    <div><b>Effect on Cash in Hand:</b></div>
    <div>Now: ${formatBDT(cashNow)}</div>
    <div>${type==='IN'?'+ Fund received':'− Fund returned'}: <b>${formatBDT(amount)}</b></div>
    ${settle ? `<div>− Reimbursed to ${esc(document.getElementById('fund_settle_employee').value)}: <b>${formatBDT(settleAmt)}</b></div>` : ''}
    <div style="margin-top:4px;">After: <b class="${after<0?'red':'green'}">${formatBDT(after)}</b></div>`;
}
function saveFund(){
  const type = document.querySelector('input[name="fund_type"]:checked').value;
  const date = document.getElementById('fund_date').value;
  const amount = round2(num(document.getElementById('fund_amount').value));
  const description = document.getElementById('fund_description').value.trim();
  const method = document.getElementById('fund_method').value;
  if (!date || amount <= 0){ alert('Please enter a date and an amount greater than zero.'); return; }
  if (date < DATA_START){ alert(`Books start on ${formatDate(DATA_START)}.`); return; }
  const settle = type === 'IN' && !document.getElementById('fund_settle_box').classList.contains('hidden') && document.getElementById('fund_settle').checked;
  let settleAmt = 0, emp = '';
  if (settle){
    emp = document.getElementById('fund_settle_employee').value;
    settleAmt = round2(num(document.getElementById('fund_settle_amount').value));
    const due = employeesWithDue()[emp] || 0;
    const eligible = sumBy(data.expenses.filter(e => e.paidBy==='EMPLOYEE' && employeeName(e)===emp && e.date <= date), e => employeeDue(e));
    if (settleAmt <= 0 || settleAmt > due){ alert(`Settle amount must be between ৳0 and ${formatBDT(due)}.`); return; }
    if (settleAmt > eligible){ alert(`Only ${formatBDT(eligible)} of ${emp}'s expenses are dated on or before ${formatDate(date)}.`); return; }
  }
  if (type === 'OUT' && !confirmCash(amount, date)) return;
  data.funds.push({ id:uid(), date, type, description, amount, method, createdAt:Date.now() });
  if (settle) allocatePayments(empDueList(emp, date), settleAmt, { date, method, note:'Settled from fund received', kind:'REIMBURSE' });
  saveData(); closeModal('fundModal'); render();
}
function deleteFund(id){
  const f = data.funds.find(x => x.id === id);
  if (!f) return;
  if (!confirm(`Delete this fund entry (${formatBDT(f.amount)} on ${formatDate(f.date)})? Cash in Hand will be recalculated.\n\nNote: reimbursements recorded with it are NOT deleted — remove them from the expense details if needed.`)) return;
  data.funds = data.funds.filter(x => x.id !== id);
  saveData(); render();
}

/* ---------------------------------------------------------
   Payments — reimbursement to employee
   Modes: EXPENSE (one expense), EMPLOYEE (all dues of one employee, oldest first)
   --------------------------------------------------------- */
let paymentCtx = null;
function empDueList(name, onOrBefore = END){ return data.expenses.filter(e => e.paidBy==='EMPLOYEE' && employeeName(e)===name && employeeDue(e) > 0 && e.date <= onOrBefore).sort(byDateAsc); }
function paymentTargets(dateLimit = END){
  if (!paymentCtx) return [];
  if (paymentCtx.mode === 'EXPENSE'){ const e = data.expenses.find(x => x.id === paymentCtx.ref); return e && e.date <= dateLimit && dueOf(e) > 0 ? [e] : []; }
  return empDueList(paymentCtx.ref, dateLimit);
}
function allocatePayments(list, amount, { date, method, note, kind }){
  let left = round2(amount);
  for (const e of list){
    if (left <= 0) break;
    const due = dueOf(e);
    if (due <= 0) continue;
    const pay = round2(Math.min(due, left));
    e.payments = e.payments || [];
    e.payments.push({ id:uid(), kind, date, amount:pay, method, note:note || '', createdAt:Date.now() });
    left = round2(left - pay);
  }
  return left;
}
function openPaymentModal(mode, ref){
  paymentCtx = { mode, ref };
  const all = paymentTargets();
  if (!all.length){ alert('Nothing is due.'); return; }
  paymentCtx.kind = 'REIMBURSE';
  const due = sumBy(all, e => dueOf(e));
  const who = employeeName(all[0]);
  document.getElementById('paymentModalTitle').textContent = `Reimburse ${who}`;
  document.getElementById('paymentSaveBtn').textContent = 'Record Reimbursement';
  document.getElementById('payment_summary').innerHTML = `
    ${mode === 'EXPENSE' ? `<div><b>${esc(all[0].description || all[0].category)}</b> · ${formatDate(all[0].date)}</div>
      <div>Paid by employee: ${formatBDT(all[0].amount)} · Already paid back: ${formatBDT(paidSum(all[0]))}</div>`
      : `<div>${all.length} unpaid expense(s) — oldest is paid first.</div>`}
    <div>Outstanding: <b>${formatBDT(due)}</b></div>`;
  const dateEl = document.getElementById('payment_date');
  const minDate = all[0].date > DATA_START ? all[0].date : DATA_START;
  dateEl.min = minDate;
  dateEl.value = todayStr() < minDate ? minDate : todayStr();
  document.getElementById('payment_amount').value = due;
  document.getElementById('payment_method').innerHTML = methodOptions('CASH');
  document.getElementById('payment_note').value = '';
  updatePaymentPreview();
  openModal('paymentModal');
}
function updatePaymentPreview(){
  const amount = num(document.getElementById('payment_amount').value);
  const date = document.getElementById('payment_date').value || todayStr();
  const due = sumBy(paymentTargets(date), e => dueOf(e));
  const cashNow = cashBalance();
  const after = round2(cashNow - amount);
  document.getElementById('payment_preview').innerHTML = amount > 0 ? `<div class="calc-box">
    <div>Cash in Hand: ${formatBDT(cashNow)} → <b class="${after<0?'red':''}">${formatBDT(after)}</b></div>
    <div>Employee Payable: ${formatBDT(due)} → <b>${formatBDT(Math.max(due-amount,0))}</b></div>
    ${amount > due ? `<div class="warn-box">Amount is more than what is due (${formatBDT(due)}) for expenses dated on or before ${formatDate(date)}.</div>` : ''}
    ${after < 0 ? `<div class="warn-box">Not enough cash in hand — add money first.</div>` : ''}
  </div>` : '';
}
function savePayment(){
  const date = document.getElementById('payment_date').value;
  const amount = round2(num(document.getElementById('payment_amount').value));
  const method = document.getElementById('payment_method').value;
  const note = document.getElementById('payment_note').value.trim();
  const list = paymentTargets(date);
  const due = sumBy(list, e => dueOf(e));
  if (!date){ alert('Please choose a payment date.'); return; }
  if (amount <= 0 || amount > due){ alert(`Amount must be greater than 0 and not more than ${formatBDT(due)} (due for expenses dated on or before ${formatDate(date)}).`); return; }
  if (!confirmCash(amount, date)) return;
  allocatePayments(list, amount, { date, method, note, kind:paymentCtx.kind });
  saveData(); closeModal('paymentModal');
  if (document.getElementById('detailModal').classList.contains('open') && paymentCtx.mode === 'EXPENSE') showExpenseDetail(paymentCtx.ref);
  render();
}
function deletePayment(expenseId, paymentId){
  const e = data.expenses.find(x => x.id === expenseId);
  if (!e) return;
  const p = (e.payments||[]).find(x => x.id === paymentId);
  if (!p || !confirm(`Delete this payment of ${formatBDT(p.amount)} on ${formatDate(p.date)}? The amount goes back to outstanding and back into Cash in Hand.`)) return;
  e.payments = e.payments.filter(x => x.id !== paymentId);
  saveData(); showExpenseDetail(expenseId); render();
}

/* ---------------------------------------------------------
   Expense detail
   --------------------------------------------------------- */
function showExpenseDetail(id){
  const e = data.expenses.find(x => x.id === id);
  if (!e) return;
  const st = expStatus(e); const due = dueOf(e);
  const isImg = !!e.photo && isImageFile(e);
  document.getElementById('detailContent').innerHTML = `
    <h2 style="margin-bottom:2px;">${esc(e.description || e.category)}</h2>
    <p class="subtitle">${esc(e.category)} · ${formatDate(e.date)} · <span class="badge-status ${st.cls}">${st.label}</span></p>
    <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin:14px 0;">
      ${kpiCard({ label:'Amount', value:e.amount })}
      ${kpiCard({ label:'Company Paid', value:expCompany(e) })}
      ${kpiCard({ label:'Employee Paid', value:expEmployee(e) })}
      ${e.paidBy!=='COMPANY' ? kpiCard({ label:'Reimbursed', value:paidSum(e), cls:'positive' }) : ''}
      ${e.paidBy!=='COMPANY' ? kpiCard({ label:'Outstanding', value:due, cls:'warning' }) : ''}
    </div>
    <div class="row" style="margin-bottom:14px;">
      ${due>0&&canWrite()?`<button class="btn sm" onclick="openPaymentModal('EXPENSE', '${e.id}')">Reimburse</button>`:''}
      ${canWrite()?`<button class="btn sm outline" onclick="openEditExpense('${e.id}')">Edit</button>`:''}
      ${canWrite()?`<button class="btn sm danger" onclick="deleteExpense('${e.id}')">Delete</button>`:''}
    </div>
    ${e.photo ? `<div class="card"><h3>${isImg?'Photo / Receipt':'Attached File'}</h3>${isImg ? `<img src="${e.photo}" style="max-height:220px;max-width:100%;border-radius:8px;">` : `<a href="${e.photo}" download="${esc(e.photoName||'attachment')}">${esc(e.photoName||'Download attachment')}</a>`}</div>` : ''}
    <div class="card">
      <h3>Details</h3>
      <div style="font-size:13px;line-height:1.9;">
        <div><span class="muted">Paid By:</span> ${PAID_BY_LABEL[e.paidBy]}${e.paidBy==='EMPLOYEE'?' — '+esc(employeeName(e)):''}</div>
        <div><span class="muted">Payment Method:</span> ${METHODS[e.paymentMethod]||esc(e.paymentMethod)}</div>
        ${e.notes ? `<div><span class="muted">Notes:</span> ${esc(e.notes)}</div>` : ''}
      </div>
    </div>
    ${(e.payments||[]).length ? `<div class="card">
      <h3>Reimbursement Payments</h3>
      <table><thead><tr><th>Date</th><th>Method</th><th>Note</th><th class="num">Amount</th><th></th></tr></thead><tbody>
      ${[...e.payments].sort(byDateAsc).map(p => `<tr><td>${formatDate(p.date)}</td><td>${METHODS[p.method]||esc(p.method)}</td><td>${esc(p.note||'—')}</td><td class="num green">${formatBDT(p.amount)}</td>
        <td>${canWrite()?`<button class="btn sm danger" onclick="deletePayment('${e.id}','${p.id}')">Delete</button>`:''}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div class="card">
      <h3>Journal Entries (Double-Entry)</h3>
      <table class="journal-table">
        <thead><tr><th>Date</th><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
        <tbody>${journalFor(e).map(j => `
          <tr><td colspan="4" class="muted" style="font-size:11px;padding-bottom:2px;">${formatDate(j.date)} · ${j.memo}</td></tr>
          ${j.lines.map(l => `<tr><td></td><td>${l.cr?'&nbsp;&nbsp;&nbsp;&nbsp;':''}${l.acc} · ${esc(accountLabelFor(e, l.acc))}</td><td class="num">${l.dr?formatBDT(l.dr):''}</td><td class="num">${l.cr?formatBDT(l.cr):''}</td></tr>`).join('')}`).join('')}
        </tbody>
      </table>
    </div>`;
  openModal('detailModal');
}

/* ---------------------------------------------------------
   Financial Summary — Month-wise or Custom Date Range.
   The same report body is used on screen, in the HTML download
   and in the PDF, so all three always show identical numbers.
   --------------------------------------------------------- */
let summaryState = { mode:'month', ym:null, from:'', to:'' };

function summaryRange(){
  if (summaryState.mode === 'range' && summaryState.from && summaryState.to){
    return { from:summaryState.from, to:summaryState.to, label:`${formatDate(summaryState.from)} to ${formatDate(summaryState.to)}` };
  }
  const ym = summaryState.ym || period.ym;
  return periodRange({ ym });
}
function renderSummary(){
  const months = availableMonths();
  const ym = summaryState.ym || period.ym;
  const pr = summaryRange();
  const r = computePeriod(pr.from, pr.to, pr.label);
  return `
    <h1>Financial Summary</h1>
    <p class="subtitle">Pick a month or a custom date range. Every card and table row below is clickable — the same links work in the downloaded PDF.</p>
    <div class="card noprint">
      <div class="row" style="margin-bottom:14px;gap:18px;">
        <label class="check-line"><input type="radio" name="summary_mode" value="month" ${summaryState.mode==='month'?'checked':''} onchange="summaryState.mode='month';render()"> Month Wise</label>
        <label class="check-line"><input type="radio" name="summary_mode" value="range" ${summaryState.mode==='range'?'checked':''} onchange="summaryState.mode='range';render()"> Custom Date Range</label>
      </div>
      ${summaryState.mode==='month' ? `
        <div class="field" style="max-width:280px;"><label>Month</label>
          <select id="summary_month" onchange="summaryState.ym=this.value;render()">
            ${months.map(m => `<option value="${m}" ${m===ym?'selected':''}>${monthLabel(m)}</option>`).join('')}
            <option value="ALL" ${ym==='ALL'?'selected':''}>All Months</option>
          </select></div>` : `
        <div class="field-row" style="max-width:520px;">
          <div class="field"><label>From Date</label><input type="date" id="summary_from" min="${DATA_START}" value="${summaryState.from}"></div>
          <div class="field"><label>To Date</label><input type="date" id="summary_to" min="${DATA_START}" value="${summaryState.to}"></div>
        </div>
        <button class="btn" onclick="applySummaryRange()">Generate Summary</button>`}
    </div>
    ${summaryState.mode==='range' && !(summaryState.from && summaryState.to) ? '' : `
    <div class="card" style="border-color:var(--purple);">
      <div class="row noprint" style="justify-content:space-between;margin-bottom:6px;">
        <h3 style="margin:0;">Report — ${esc(pr.label)}</h3>
        <div class="row">
          <button class="btn sm" onclick="downloadSummaryPdf()">⬇ Download PDF</button>
          <button class="btn sm outline" onclick="downloadSummaryHtml()">⬇ Download HTML</button>
        </div>
      </div>
      <div class="rpt">${reportBody(r)}</div>
    </div>`}`;
}
function applySummaryRange(){
  const from = document.getElementById('summary_from').value;
  const to = document.getElementById('summary_to').value;
  if (!from || !to){ alert('Please select both a From and To date.'); return; }
  if (to < from){ alert('"To" date must be on or after the "From" date.'); return; }
  summaryState.from = from < DATA_START ? DATA_START : from; summaryState.to = to;
  render();
}

function reportBody(r){
  const B = n => formatBDT(n);
  const K = [
    { l:'Opening Cash', v:r.openingCash, s:'Cash in hand at start', c:'info', t:'sec-cash' },
    { l:'Funds Received', v:r.fundsIn, s:'Money received from company', c:'pos', t:'sec-cash' },
    { l:'Total Expenses', v:r.totalExpenses, s:`${r.expenses.length} expense(s)`, c:'neg', t:'sec-category' },
    { l:'Company Paid', v:r.companyPaid, s:'Paid from company fund', c:'', t:'sec-register' },
    { l:'Employee Paid', v:r.employeePaid, s:'Paid from own pocket', c:'', t:'sec-employee' },
    { l:'Total Reimbursed', v:r.reimbursed, s:'Paid back to employees', c:'pos', t:'sec-employee' },
    ...(r.fundsOut ? [{ l:'Funds Returned', v:r.fundsOut, s:'Cash returned / withdrawn', c:'', t:'sec-cash' }] : []),
    { l:'Closing Cash', v:r.closingCash, s:'Cash in hand at end', c: r.closingCash<0?'neg':'pos', t:'sec-cash' },
    { l:'Employee Payable', v:r.employeeOutstanding, s:'Employee outstanding at end', c:'warn', t:'sec-employee' },
  ];
  const back = `<a class="back" href="#sec-exec">↑ Back to Executive Summary</a>`;
  const statusTxt = e => { const d = dueOf(e, r.to); return d > 0 ? `<span class="am">${paidSum(e, r.to) > 0 ? 'Partial' : 'Reimb. due'} ${B(d)}</span>` : `<span class="g">${e.paidBy==='COMPANY'?'Paid':'Reimbursed'}</span>`; };
  const paidByTxt = e => e.paidBy === 'EMPLOYEE' ? `Employee — ${esc(employeeName(e))}` : 'Company fund';
  const catId = i => `cat-${i}`;

  return `
    <div class="rpt-head">
      <img src="${REPORT_LOGO}" alt="NidusLab" style="width:46px;height:46px;">
      <div><div class="rpt-title"><span style="color:#0A0A0A;">Nidus</span><span style="color:#2D4A8F;">Lab</span> — Financial Summary</div>
      <div class="meta">Report Period: <b>${esc(r.label)}</b> (${formatDate(r.from)} – ${r.to===END?'today':formatDate(r.to)}) · Generated: ${new Date().toLocaleString('en-GB')}</div></div>
    </div>

    <section id="sec-exec" style="padding-top:12px;">
      <h2>1. Executive Summary <span class="hint-click">— click a card to jump to its details</span></h2>
      <div class="kpis">
        ${K.map(k => `<a class="k ${k.c}" href="#${k.t}"><div class="l">${k.l}</div><div class="v">${B(k.v)}</div><div class="s">${k.s}</div><div class="c">View details ▸</div></a>`).join('')}
      </div>
      <div class="toc"><b style="margin-right:10px;">Contents:</b>
        <a href="#sec-cash">2. Cash Flow &amp; Cash Book</a>
        <a href="#sec-category">3. Expenses by Category</a>
        <a href="#sec-register">4. Expense Register</a>
        <a href="#sec-employee">5. Employee Reimbursements</a>
        <a href="#sec-glossary">6. Terms Used</a>
      </div>
    </section>

    <section id="sec-cash">
      <h2>2. Cash Flow Statement &amp; Cash Book</h2>
      <div class="tw"><table><tbody>
        <tr><td>Opening Cash Balance</td><td class="r">${B(r.openingCash)}</td></tr>
        <tr><td>Add: Funds Received from Company</td><td class="r g">+ ${B(r.fundsIn)}</td></tr>
        <tr><td>Less: Company-paid Expenses</td><td class="r rd">− ${B(r.companyPaid)}</td></tr>
        <tr><td>Less: Reimbursements Paid to Employees</td><td class="r rd">− ${B(r.reimbursed)}</td></tr>
        <tr><td>Less: Funds Returned / Withdrawn</td><td class="r rd">− ${B(r.fundsOut)}</td></tr>
        <tr class="tot"><td>Closing Cash Balance (Cash in Hand)</td><td class="r">${B(r.closingCash)}</td></tr>
      </tbody></table></div>
      <h3>Cash Book — every cash movement</h3>
      <div class="tw"><table>
        <thead><tr><th>Date</th><th>Description</th><th class="r">Cash In</th><th class="r">Cash Out</th><th class="r">Balance</th></tr></thead>
        <tbody>
          <tr><td>${formatDate(r.from)}</td><td class="mut">Opening balance</td><td></td><td></td><td class="r"><b>${B(r.openingCash)}</b></td></tr>
          ${r.cashRows.map(t => `<tr><td>${formatDate(t.date)}</td><td>${esc(t.desc)}</td><td class="r g">${t.inAmt?B(t.inAmt):''}</td><td class="r rd">${t.outAmt?B(t.outAmt):''}</td><td class="r"><b>${B(t.balance)}</b></td></tr>`).join('')}
          <tr class="tot"><td colspan="2">Closing balance</td><td class="r">${B(r.fundsIn)}</td><td class="r">${B(r.cashOut)}</td><td class="r">${B(r.closingCash)}</td></tr>
        </tbody></table></div>
      ${back}
    </section>

    <section id="sec-category">
      <h2>3. Expenses by Category <span class="hint-click">— click a category to see its expenses</span></h2>
      <div class="tw"><table>
        <thead><tr><th>Category</th><th class="r">#</th><th class="r">Total</th><th class="r">Company Paid</th><th class="r">Employee Paid</th></tr></thead>
        <tbody>${r.byCategory.length ? r.byCategory.map((c,i) => `<tr><td><a class="lnk" href="#${catId(i)}">▸ ${esc(c.name)}</a></td><td class="r">${c.count}</td><td class="r"><b>${B(c.total)}</b></td><td class="r">${B(c.company)}</td><td class="r">${B(c.employee)}</td></tr>`).join('')
          + `<tr class="tot"><td>Total</td><td class="r">${r.expenses.length}</td><td class="r">${B(r.totalExpenses)}</td><td class="r">${B(r.companyPaid)}</td><td class="r">${B(r.employeePaid)}</td></tr>`
          : '<tr><td colspan="5" class="mut">No expenses in this period.</td></tr>'}</tbody></table></div>
      ${back}
    </section>

    <section id="sec-register">
      <h2>4. Expense Register (by Category)</h2>
      ${r.byCategory.length ? r.byCategory.map((c,i) => `
        <h3 id="${catId(i)}">${esc(c.name)} — ${B(c.total)} <a class="back" style="margin:0 0 0 8px;font-weight:600;" href="#sec-category">↑ categories</a></h3>
        <div class="tw"><table>
          <thead><tr><th>Date</th><th>Description</th><th>Paid By</th><th class="r">Amount</th><th>Status</th></tr></thead>
          <tbody>${c.items.map(e => `<tr><td>${formatDate(e.date)}</td>
            <td>${esc(e.description||'—')}${e.notes?`<div class="mut" style="font-size:11px;">${esc(e.notes)}</div>`:''}${e.photo && isImageFile(e) ? `<img class="thumb" src="${e.photo}">` : (e.photo ? `<div class="mut" style="font-size:11px;">📎 ${esc(e.photoName||'attachment')}</div>` : '')}</td>
            <td>${paidByTxt(e)}</td><td class="r"><b>${B(e.amount)}</b></td><td>${statusTxt(e)}</td></tr>`).join('')}</tbody>
        </table></div>`).join('') : '<p class="mut">No expenses in this period.</p>'}
      ${back}
    </section>

    <section id="sec-employee">
      <h2>5. Employee Reimbursements (Employee Payable)</h2>
      <div class="tw"><table>
        <thead><tr><th>Employee</th><th class="r">Opening Due</th><th class="r">Paid (own pocket)</th><th class="r">Reimbursed</th><th class="r">Closing Due</th></tr></thead>
        <tbody>${r.byEmployee.length ? r.byEmployee.map(x => `<tr><td><b>${esc(x.name)}</b></td><td class="r">${B(x.opening)}</td><td class="r">${B(x.paid)}</td><td class="r g">${B(x.reimbursed)}</td><td class="r ${x.closing>0?'am':'g'}">${B(x.closing)}</td></tr>`).join('')
          + `<tr class="tot"><td>Total</td><td class="r">${B(r.openingEmployeeDue)}</td><td class="r">${B(r.employeePaid)}</td><td class="r">${B(r.reimbursed)}</td><td class="r">${B(r.employeeOutstanding)}</td></tr>`
          : '<tr><td colspan="5" class="mut">No employee-paid expenses.</td></tr>'}</tbody></table></div>
      <h3>Reimbursement payments in this period</h3>
      <div class="tw"><table>
        <thead><tr><th>Date</th><th>Employee</th><th>Against Expense</th><th>Method</th><th class="r">Amount</th></tr></thead>
        <tbody>${r.reimbList.length ? r.reimbList.map(p => `<tr><td>${formatDate(p.date)}</td><td>${esc(employeeName(p.expense))}</td><td>${esc(p.expense.description||p.expense.category)} <span class="mut">(${formatDate(p.expense.date)})</span></td><td>${METHODS[p.method]||esc(p.method)}</td><td class="r g">${B(p.amount)}</td></tr>`).join('') : '<tr><td colspan="5" class="mut">No reimbursements paid in this period.</td></tr>'}</tbody></table></div>
      ${back}
    </section>

    <section id="sec-glossary">
      <h2>6. Terms Used</h2>
      <dl class="gl">
        <dt>Cash in Hand (Funds in Hand)</dt><dd>Company money currently held = Funds Received − Company-paid Expenses − Reimbursements − Funds Returned.</dd>
        <dt>Total Expenses</dt><dd>All expenses dated in the period, no matter who paid (Company Paid + Employee Paid).</dd>
        <dt>Company Paid</dt><dd>Expenses paid directly from the company fund; they reduce Cash in Hand immediately.</dd>
        <dt>Employee Paid</dt><dd>Expenses an employee paid from their own pocket; recorded as Employee Payable until reimbursed.</dd>
        <dt>Total Reimbursed</dt><dd>Money paid back to employees from the company fund during the period.</dd>
        <dt>Employee Payable (Employee Outstanding)</dt><dd>Amount the company still owes employees at the end of the period (carried forward).</dd>
      </dl>
      ${back}
    </section>
    <div class="foot">NidusLab Finance &amp; Accounting · Prepared By: __________ &nbsp;&nbsp; Approved By: __________</div>`;
}

function buildReportDocument(r){
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NidusLab Financial Summary — ${esc(r.label)}</title>
  <style>
    html{scroll-behavior:smooth;}
    body{font-family:'Segoe UI',Arial,Helvetica,sans-serif;max-width:860px;margin:24px auto;padding:0 18px;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    @page{size:A4;margin:12mm;}
    @media print{ body{margin:0;max-width:none;padding:0;} .rpt section{padding-top:14px;} }
    ${REPORT_CSS}
  </style></head><body><div class="rpt">${reportBody(r)}</div></body></html>`;
}
function reportFileName(r){ return `NidusLab-Financial-Summary-${r.label.replace(/[^a-z0-9]+/gi,'_')}`; }
function currentSummaryReport(){ const pr = summaryRange(); return computePeriod(pr.from, pr.to, pr.label); }

async function downloadSummaryHtml(){
  const r = currentSummaryReport();
  let html = buildReportDocument(r);
  const urls = [...new Set([...html.matchAll(/<img class="thumb" src="(https?:[^"]+)"/g)].map(m => m[1]))];
  for (const u of urls){ try { html = html.split(u).join(await toDataUri(u)); } catch (e){} }
  const blob = new Blob([html], { type:'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = reportFileName(r) + '.html';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** PDF: renders the report in a hidden frame and opens the print dialog → choose "Save as PDF".
 *  Chrome / Edge keep the internal links, so every card and category stays clickable in the PDF. */
function downloadSummaryPdf(){
  const r = currentSummaryReport();
  const old = document.getElementById('pdfFrame'); if (old) old.remove();
  const iframe = document.createElement('iframe');
  iframe.id = 'pdfFrame';
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  doc.open(); doc.write(buildReportDocument(r)); doc.close();
  const prevTitle = document.title;
  const go = () => {
    document.title = reportFileName(r); // used as the default PDF file name
    try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } finally { setTimeout(() => { document.title = prevTitle; }, 1500); }
  };
  const imgs = [...doc.images];
  Promise.all(imgs.map(img => img.complete ? null : new Promise(res => { img.onload = img.onerror = res; }))).then(() => setTimeout(go, 150));
}

/* ---------------------------------------------------------
   Responsive topbar + bootstrap
   --------------------------------------------------------- */
function handleResize(){
  const isMobile = window.innerWidth <= 800;
  document.getElementById('mobileTopbar').style.display = isMobile ? 'flex' : 'none';
  document.getElementById('desktopTopbar').style.display = isMobile ? 'none' : 'flex';
}
window.addEventListener('resize', handleResize);
handleResize();

boot();

/* =========================================================
   Supabase client, auth, data layer (diff-sync), realtime
   ========================================================= */
const CFG = window.NIDUS_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
const EMAIL_DOMAIN = CFG.emailDomain || 'niduslab-finance.app';
const BUCKET = 'fin-receipts';
let me = null;          // { id, username, name, role, email }
let data = null;        // { employees:[], expenses:[], funds:[] }  (same shape the accounting engine expects)
let pendingCount = 0;
let animNext = true;    // play entrance animation on next render

const canWrite = () => !!me && (me.role === 'ADMIN' || me.role === 'FINANCE');
const isAdmin = () => !!me && me.role === 'ADMIN';
const ROLE_LABEL = { ADMIN:'Admin', FINANCE:'Finance', EMPLOYEE:'Employee', PENDING:'Pending approval' };
// Finance-only login for an email that already belongs to another NidusLab app on the shared Supabase project.
function aliasEmail(real){ return 'em+' + String(real).trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') + '@' + EMAIL_DOMAIN; }
function usernameToEmail(u){ u = String(u || '').trim().toLowerCase(); return u.includes('@') ? u : `${u}@${EMAIL_DOMAIN}`; }
const $ = id => document.getElementById(id);

/* ---------- Toast / loader / sync indicator ---------- */
function toast(msg, type = 'ok', ms = 3400){
  const box = $('toasts'); if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg; box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 350); }, ms);
}
function setLoader(on, msg){
  const l = $('loader'); if (!l) return;
  l.classList.toggle('hidden', !on);
  if (msg) $('loaderMsg').textContent = msg;
}
function setSync(state){
  const el = $('syncState'); if (!el) return;
  const map = { live:['Live sync','ok'], saving:['Saving…','busy'], offline:['Offline','off'], error:['Sync error','err'] };
  const [txt, cls] = map[state] || map.live;
  el.className = 'sync ' + cls; el.querySelector('.sync-txt').textContent = txt;
}
function setBusy(btn, busy, label){
  if (!btn) return;
  if (busy){ btn.dataset.label = btn.textContent; btn.disabled = true; btn.classList.add('busy'); if (label) btn.textContent = label; }
  else { btn.disabled = false; btn.classList.remove('busy'); if (btn.dataset.label) btn.textContent = btn.dataset.label; }
}

/* ---------- Screens ---------- */
function showScreen(which){
  $('authScreen').style.display = which === 'auth' ? 'flex' : 'none';
  $('pendingScreen').style.display = which === 'pending' ? 'flex' : 'none';
  $('appRoot').classList.toggle('hidden', which !== 'app');
}
function showAuthForm(which){
  $('loginFormBox').classList.toggle('hidden', which !== 'login');
  $('signupFormBox').classList.toggle('hidden', which !== 'signup');
  $('login_error').textContent = ''; $('signup_error').textContent = '';
}

/* ---------- Auth ---------- */
async function handleLogin(){
  const uname = $('login_username').value.trim();
  const password = $('login_password').value;
  const err = $('login_error'); err.textContent = '';
  if (!uname || !password){ err.textContent = 'Enter your username and password.'; return; }
  const btn = $('loginBtn'); setBusy(btn, true, 'Signing in…');
  let error = null;
  if (uname.includes('@')){
    const r1 = await sb.auth.signInWithPassword({ email: aliasEmail(uname), password });
    if (r1.error){ const r2 = await sb.auth.signInWithPassword({ email: uname.toLowerCase(), password }); error = r2.error; }
  } else error = (await sb.auth.signInWithPassword({ email: usernameToEmail(uname), password })).error;
  setBusy(btn, false);
  if (error){ err.textContent = /invalid login/i.test(error.message) ? 'Invalid username or password.' : error.message; return; }
  await afterLogin();
}
async function handleSignup(){
  const name = $('signup_name').value.trim();
  const raw = $('signup_username').value.trim().toLowerCase();
  const password = $('signup_password').value;
  const confirmPw = $('signup_confirm').value;
  const invite = ($('signup_invite').value || '').trim();
  const err = $('signup_error'); err.textContent = '';
  if (!name || !raw || !password){ err.textContent = 'Please fill in all fields.'; return; }
  let email, username;
  if (raw.includes('@')){
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)){ err.textContent = 'Enter a valid email address.'; return; }
    email = aliasEmail(raw); username = raw.split('@')[0].replace(/[^a-z0-9._-]/g, '').slice(0, 30);
    if (username.length < 3) username = (username + 'user').slice(0, 30);
  } else {
    if (!/^[a-z0-9._-]{3,30}$/.test(raw)){ err.textContent = 'Username: 3–30 characters, letters, numbers, . _ - only.'; return; }
    email = usernameToEmail(raw); username = raw;
  }
  if (password.length < 6){ err.textContent = 'Password must be at least 6 characters.'; return; }
  if (password !== confirmPw){ err.textContent = 'Passwords do not match.'; return; }
  const btn = $('signupBtn'); setBusy(btn, true, 'Creating account…');
  const { data: d, error } = await sb.auth.signUp({
    email, password,
    options: { data: { app: 'niduslab_finance', name, username, invite, real_email: raw.includes('@') ? raw : null } },
  });
  setBusy(btn, false);
  if (error){
    const taken = /already registered|already exists|duplicate|database error/i.test(error.message);
    err.textContent = !taken ? error.message : raw.includes('@') ? 'This email already has a Finance account. Use Sign In.' : 'That username is already taken. Try another.';
    return;
  }
  if (!d.session){ err.textContent = 'Account created, but email confirmation is on. Ask the admin to disable it.'; return; }
  await afterLogin();
}
async function afterLogin(){
  setLoader(true, 'Loading your workspace…');
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user){ showScreen('auth'); return; }
    const { data: profRow, error } = await sb.from('fin_profiles').select('*').eq('id', user.id).maybeSingle();
    if (error) throw error;
    let prof2 = profRow;
    if (!prof2){
      await sb.auth.signOut(); showScreen('auth');
      $('login_error').textContent = 'No Finance account for this login. Please Sign Up (your other NidusLab apps are not affected).';
      return;
    }
    const prof_ = prof2;
    const prof = prof_;
    me = { id: prof.id, username: prof.username, name: prof.full_name || prof.username, role: prof.role, email: (user.user_metadata || {}).real_email || user.email, authEmail: user.email, avatarPath: prof.avatar_path || null, avatarUrl: null };
    if (prof.role === 'PENDING'){ $('pending_name').textContent = me.name; showScreen('pending'); return; }
    await enterApp();
  } catch (e){
    console.error(e); showScreen('auth');
    $('login_error').textContent = 'Could not load your account: ' + (e.message || e);
  } finally { setLoader(false); }
}
async function handleLogout(){ stopRealtime(); await sb.auth.signOut(); location.reload(); }
async function handleChangePassword(){
  const cur = $('cp_current').value, next = $('cp_new').value, conf = $('cp_confirm').value;
  const err = $('cp_error'); err.style.color = ''; err.textContent = '';
  if (next.length < 6){ err.textContent = 'New password must be at least 6 characters.'; return; }
  if (next !== conf){ err.textContent = 'New passwords do not match.'; return; }
  const { error: e1 } = await sb.auth.signInWithPassword({ email: me.authEmail || me.email, password: cur });
  if (e1){ err.textContent = 'Current password is incorrect.'; return; }
  const { error: e2 } = await sb.auth.updateUser({ password: next });
  if (e2){ err.textContent = e2.message; return; }
  err.style.color = 'var(--green)'; err.textContent = 'Password updated successfully.';
  setTimeout(() => { closeModal('changePasswordModal'); err.style.color = ''; err.textContent = ''; ['cp_current','cp_new','cp_confirm'].forEach(id => $(id).value = ''); }, 900);
}
async function enterApp(){
  showScreen('app');
  $('topbar_name').textContent = me.name;
  $('topbar_role').textContent = ROLE_LABEL[me.role] || me.role;
  $('topbar_avatar').textContent = (me.name || '?').trim().slice(0, 1).toUpperCase();
  $('mobile_avatar').textContent = $('topbar_avatar').textContent;
  await loadAvatar();
  if (!canWrite()) state.currentTab = 'mine';
  setLoader(true, 'Syncing your books…');
  await reloadData(true);
  if (isAdmin()) await refreshPendingBadge();
  startRealtime();
  animNext = true; render();
  const nl = $('navList'); nl.classList.add('intro'); setTimeout(() => nl.classList.remove('intro'), 1600);
  setLoader(false);
}

/* ---------- Data: fetch ---------- */
async function fetchRows(table){
  const out = [], size = 1000;
  for (let from = 0; ; from += size){
    const { data: rows, error } = await sb.from(table).select('*').order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, from + size - 1);
    if (error) throw error;
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}
function buildData(emp, exp, pay, fund, cf){
  const d = { version:3, employees: emp.map(x => x.name).sort((a, b) => a.localeCompare(b)), costFunds:(cf || []).map(x => x.name), expenses:[], requests:[], mine:[], funds:[] };
  const byId = {};
  exp.forEach(r => {
    const e = {
      id:r.id, date:r.date, category:r.category, accountCode: CATEGORY_ACCOUNT[r.category] || r.account_code || '5150', accountLabel:null,
      description:r.description || '', amount:num(r.amount), paidBy:r.paid_by, paymentMethod:r.payment_method || 'CASH',
      employee:r.paid_by === 'EMPLOYEE' ? (r.employee || '') : null, notes:r.notes || '',
      costFund:r.cost_fund || '', status:r.status || 'APPROVED',
      photoPath:r.photo_path || null, photoName:r.photo_name || null, photoMime:r.photo_mime || null, photo:null,
      createdAt:Date.parse(r.created_at) || 0, payments:[],
    };
    byId[e.id] = e;
    if (!canWrite()) d.mine.push(e);
    else if (e.status === 'PENDING') d.requests.push(e);
    else d.expenses.push(e);
  });
  pay.forEach(p => {
    const e = byId[p.expense_id];
    if (e && e.paidBy === 'EMPLOYEE') e.payments.push({ id:p.id, kind:p.kind || 'REIMBURSE', date:p.date, amount:num(p.amount), method:p.method || 'CASH', note:p.note || '', createdAt:Date.parse(p.created_at) || 0 });
  });
  fund.forEach(f => d.funds.push({ id:f.id, date:f.date, type:f.type, description:f.description || '', amount:num(f.amount), method:f.method || 'CASH', createdAt:Date.parse(f.created_at) || 0 }));
  return d;
}
const allExp = d => d.expenses.concat(d.requests || [], d.mine || []);
let members = [];
async function attachSignedUrls(list){
  const paths = list.filter(e => e.photoPath).map(e => e.photoPath);
  if (!paths.length) return;
  const { data: signed, error } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
  if (error || !signed) return;
  const m = new Map(signed.map(s => [s.path, s.signedUrl]));
  list.forEach(e => { if (e.photoPath && m.has(e.photoPath)) e.photo = m.get(e.photoPath); });
}
function isImageFile(e){
  return !!e.photo && (String(e.photoMime || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(e.photoName || e.photoPath || ''));
}
async function reloadData(force){
  const [emp, exp, pay, fund, cf, mem] = await Promise.all([fetchRows('fin_employees'), fetchRows('fin_expenses'), fetchRows('fin_expense_payments'), canWrite() ? fetchRows('fin_funds') : Promise.resolve([]), fetchRows('fin_cost_funds'), sb.from('fin_profiles').select('id,username,full_name,role').neq('role', 'PENDING')]);
  members = (mem.data || []).map(m => ({ id:m.id, name:m.full_name || m.username, role:m.role })).sort((a, b) => a.name.localeCompare(b.name));
  const nd = buildData(emp, exp, pay, fund, cf);
  const s = snapshotOf(nd);
  if (!force && data && s.sig === snap.sig) return false;
  if (data && !force){ // keep already-resolved signed URLs / local previews for unchanged photos
    const old = new Map(allExp(data).map(e => [e.id, e]));
    allExp(nd).forEach(e => { const o = old.get(e.id); if (o && o.photoPath === e.photoPath && o.photo) e.photo = o.photo; });
  }
  await attachSignedUrls(allExp(nd).filter(e => !e.photo));
  data = nd; snap = s;
  return true;
}

/* ---------- Data: snapshot + diff push ---------- */
let snap = { exp:new Map(), pay:new Map(), fund:new Map(), emp:new Set(), cf:new Set(), sig:'' };
const iso = ms => new Date(ms || Date.now()).toISOString();
function expRow(e){ return { id:e.id, date:e.date, category:e.category, account_code:e.accountCode || '5150', description:e.description || '', amount:round2(num(e.amount)), paid_by:e.paidBy, payment_method:e.paymentMethod || 'CASH', employee:e.paidBy === 'EMPLOYEE' ? (e.employee || null) : null, notes:e.notes || '', cost_fund:e.costFund || '', status:e.status || 'APPROVED', photo_path:e.photoPath || null, photo_name:e.photoName || null, photo_mime:e.photoMime || null, created_at:iso(e.createdAt) }; }
function payRow(p, eid){ return { id:p.id, expense_id:eid, kind:p.kind || 'REIMBURSE', date:p.date, amount:round2(num(p.amount)), method:p.method || 'CASH', note:p.note || '', created_at:iso(p.createdAt) }; }
function fundRow(f){ return { id:f.id, date:f.date, type:f.type, description:f.description || '', amount:round2(num(f.amount)), method:f.method || 'CASH', created_at:iso(f.createdAt) }; }
function snapshotOf(d){
  const s = { exp:new Map(), pay:new Map(), fund:new Map(), emp:new Set(d.employees), cf:new Set(d.costFunds || []), sig:'' };
  allExp(d).forEach(e => {
    const r = expRow(e); s.exp.set(e.id, { json:JSON.stringify(r), row:r });
    (e.payments || []).forEach(p => { const pr = payRow(p, e.id); s.pay.set(p.id, { json:JSON.stringify(pr), row:pr }); });
  });
  d.funds.forEach(f => { const r = fundRow(f); s.fund.set(f.id, { json:JSON.stringify(r), row:r }); });
  const parts = [];
  ['exp','pay','fund'].forEach(k => { [...s[k].entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).forEach(([id, v]) => parts.push(k + id + v.json)); });
  parts.push('emp' + [...s.emp].sort().join('|'));
  parts.push('cf' + [...s.cf].sort().join('|'));
  s.sig = parts.join('\n');
  return s;
}
let pushChain = Promise.resolve(), pushing = 0, rtPending = false;
function saveData(){
  pushing++; setSync('saving');
  pushChain = pushChain.then(pushChanges).catch(async err => {
    console.error('Sync failed', err);
    setSync('error'); toast('Could not save: ' + (err.message || err) + ' — reloading from server.', 'err', 6000);
    try { await reloadData(true); animNext = false; render(); } catch (e2){ console.error(e2); }
  }).finally(() => { pushing--; if (!pushing){ setSync('live'); if (rtPending){ rtPending = false; scheduleRefresh(); } } });
}
function chk(res){ if (res && res.error) throw res.error; return res; }
function safeName(n){ return String(n || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80); }
async function pushChanges(){
  // 1) upload new attachments
  for (const e of allExp(data)){
    if (e.photoFile){
      const f = e.photoFile;
      const path = `${e.id}/${Date.now()}-${safeName(f.name)}`;
      chk(await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || 'application/octet-stream', upsert: false }));
      e.photoPath = path; e.photoMime = f.type || null; e.photoName = f.name; delete e.photoFile;
    }
  }
  const cur = snapshotOf(data);
  const changed = m => [...cur[m].entries()].filter(([id, v]) => !snap[m].has(id) || snap[m].get(id).json !== v.json).map(([, v]) => v.row);
  const removed = m => [...snap[m].keys()].filter(id => !cur[m].has(id));
  const upE = changed('exp'), upF = changed('fund'), upP = changed('pay');
  const newEmp = [...cur.emp].filter(n => !snap.emp.has(n)), delEmp = [...snap.emp].filter(n => !cur.emp.has(n));
  const delP = removed('pay'), delE = removed('exp'), delF = removed('fund');
  const newCf = [...cur.cf].filter(n => !snap.cf.has(n)), delCf = [...snap.cf].filter(n => !cur.cf.has(n));

  if (upE.length) chk(await sb.from('fin_expenses').upsert(upE, { onConflict:'id' }));
  if (upF.length) chk(await sb.from('fin_funds').upsert(upF, { onConflict:'id' }));
  if (newEmp.length) chk(await sb.from('fin_employees').upsert(newEmp.map(name => ({ name })), { onConflict:'name', ignoreDuplicates:true }));
  if (newCf.length) chk(await sb.from('fin_cost_funds').upsert(newCf.map(name => ({ name })), { onConflict:'name', ignoreDuplicates:true }));
  if (upP.length) chk(await sb.from('fin_expense_payments').upsert(upP, { onConflict:'id' }));
  if (delP.length) chk(await sb.from('fin_expense_payments').delete().in('id', delP));
  if (delE.length) chk(await sb.from('fin_expenses').delete().in('id', delE));
  if (delF.length) chk(await sb.from('fin_funds').delete().in('id', delF));
  if (delCf.length) chk(await sb.from('fin_cost_funds').delete().in('name', delCf));
  if (delEmp.length) chk(await sb.from('fin_employees').delete().in('name', delEmp));

  // 2) clean up replaced / orphaned attachments (best effort)
  const orphan = [];
  snap.exp.forEach((v, id) => {
    const oldPath = v.row.photo_path; if (!oldPath) return;
    const now = cur.exp.get(id);
    if (!now || now.row.photo_path !== oldPath) orphan.push(oldPath);
  });
  if (orphan.length) sb.storage.from(BUCKET).remove(orphan).catch(() => {});
  snap = cur;
}

/* ---------- Realtime (other users' changes appear live) ---------- */
let rtChannel = null, rtTimer = null;
function startRealtime(){
  if (rtChannel) return;
  rtChannel = sb.channel('fin-live');
  ['fin_expenses','fin_expense_payments','fin_funds','fin_employees','fin_profiles','fin_cost_funds'].forEach(t => rtChannel.on('postgres_changes', { event:'*', schema:'public', table:t }, () => scheduleRefresh()));
  rtChannel.subscribe(st => { if (!pushing) setSync(st === 'SUBSCRIBED' ? 'live' : (st === 'CLOSED' || st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') ? 'offline' : 'live'); });
  setInterval(() => { if (data) attachSignedUrls(allExp(data)); }, 45 * 60 * 1000);
}
function stopRealtime(){ if (rtChannel){ sb.removeChannel(rtChannel); rtChannel = null; } }
function scheduleRefresh(){
  clearTimeout(rtTimer);
  rtTimer = setTimeout(async () => {
    if (pushing){ rtPending = true; return; }
    try {
      const changedData = await reloadData(false);
      if (isAdmin()) await refreshPendingBadge(true);
      if (changedData){ animNext = false; render(); }
      else if (state.currentTab === 'users') loadUsersTab();
    } catch (e){ console.error(e); setSync('offline'); }
  }, 900);
}

/* ---------- Admin: users page ---------- */
async function refreshPendingBadge(skipRender){
  const { count } = await sb.from('fin_profiles').select('id', { count:'exact', head:true }).eq('role', 'PENDING');
  const n = count || 0;
  if (n !== pendingCount){ pendingCount = n; if (!skipRender) renderNav(); else renderNav(); }
}
function renderUsersShell(){
  return `
    <div class="page-head">
      <div><h1>Users &amp; Access</h1><p class="subtitle" style="margin-bottom:0;">Approve new sign-ups and set roles. <b>Admin</b> &amp; <b>Finance</b> can add / edit / delete. <b>Employee</b> sees only own expenses and sends requests for approval. <b>Pending</b> has no access.</p></div>
    </div>
    <div class="card" id="inviteCard" style="margin-top:18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;"><div style="flex:1;min-width:220px;"><div style="font-weight:700;">Team invite code</div><div class="muted" style="font-size:13px;">Share with your team. Anyone who signs up with it joins instantly as <b>Employee</b> (own expenses + requests). Change role below if needed.</div></div><code id="inviteCode" style="font-size:18px;font-weight:800;letter-spacing:1px;padding:8px 14px;border-radius:10px;background:#eef2fb;">…</code><button class="btn secondary" onclick="copyInvite()">Copy</button><button class="btn secondary" onclick="newInvite()">New code</button></div>
    <div class="card" style="padding:0;overflow-x:auto;margin-top:18px;" id="usersCard"><div class="empty">Loading users…</div></div>`;
}
async function loadInvite(){
  const { data } = await sb.from('fin_settings').select('value').eq('key','invite_code').maybeSingle();
  const el = $('inviteCode'); if (el) el.textContent = data ? data.value : '—';
}
function copyInvite(){ const t = $('inviteCode').textContent; try { navigator.clipboard.writeText(t); toast('Code copied.'); } catch (e){ toast(t); } }
async function newInvite(){
  if (!confirm('Generate a new code? The old code will stop working.')) return;
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = '';
  for (let i = 0; i < 4; i++) c += a[Math.floor(Math.random() * a.length)];
  const code = 'NIDUS-FIN-' + c;
  const { error } = await sb.from('fin_settings').upsert({ key:'invite_code', value: code });
  if (error){ toast('Could not change code: ' + error.message, 'err'); return; }
  toast('New code ready.'); loadInvite();
}
async function loadUsersTab(){
  const card = $('usersCard'); if (!card) return;
  loadInvite();
  const { data: rows, error } = await sb.from('fin_profiles').select('*').order('created_at', { ascending:false });
  if (error){ card.innerHTML = `<div class="empty">Could not load users: ${esc(error.message)}</div>`; return; }
  pendingCount = rows.filter(r => r.role === 'PENDING').length; renderNav();
  card.innerHTML = `<table>
    <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Joined</th></tr></thead>
    <tbody>${rows.map(u => `<tr>
      <td><b>${esc(u.full_name || '—')}</b>${u.id === me.id ? ' <span class="tag">You</span>' : ''}</td>
      <td class="muted">${esc(u.username)}</td>
      <td><select class="inp role-sel ${u.role === 'PENDING' ? 'pending' : ''}" ${u.id === me.id ? 'disabled' : ''} onchange="changeUserRole('${u.id}', this.value)">
        ${['PENDING','EMPLOYEE','FINANCE','ADMIN'].map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}
      </select></td>
      <td class="muted">${formatDate(u.created_at)}</td></tr>`).join('')}
    </tbody></table>`;
}
async function changeUserRole(id, role){
  const { error } = await sb.from('fin_profiles').update({ role }).eq('id', id);
  if (error){ toast('Could not change role: ' + error.message, 'err'); return; }
  toast('Role updated.'); loadUsersTab();
}

/* ---------- Attachments helpers used by the expense modal ---------- */
function photoFields(){
  const file = window._expPhotoFile, keep = window._expPhotoKeep;
  if (file) return { photoFile:file, photoPath:(keep && keep.path) || null, photoName:file.name, photoMime:file.type || null, photo:URL.createObjectURL(file) };
  if (keep) return { photoFile:null, photoPath:keep.path || null, photoName:keep.name || null, photoMime:keep.mime || null, photo:keep.url || null };
  return { photoFile:null, photoPath:null, photoName:null, photoMime:null, photo:null };
}

/* ---------- Boot ---------- */
async function boot(){
  try { REPORT_CSS = await (await fetch('css/report.css')).text(); } catch (e){ REPORT_CSS = ''; }
  try { REPORT_LOGO = await toDataUri('assets/logo-navy-sm.png'); } catch (e){ REPORT_LOGO = 'assets/logo-navy-sm.png'; }
  const { data: { session } } = await sb.auth.getSession();
  if (session){ await afterLogin(); }
  else { showScreen('auth'); }
  setLoader(false);
}
async function toDataUri(url){
  const blob = await (await fetch(url)).blob();
  return await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}

/* =========================================================
   UI additions: KPI cards (navy gradient), ring, count-up, entrance animation
   ========================================================= */
const KPI_SVG = {
  wallet:   '<svg viewBox="0 0 20 20" fill="none"><rect x="2.5" y="4.5" width="15" height="11" rx="2.5" stroke="currentColor" stroke-width="1.7"/><path d="M2.5 8h15M13.5 12h1.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  inflow:   '<svg viewBox="0 0 20 20" fill="none"><path d="M10 3v9m0 0L6.5 8.5M10 12l3.5-3.5M4 16h12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  outflow:  '<svg viewBox="0 0 20 20" fill="none"><path d="M10 16V7m0 0L6.5 10.5M10 7l3.5 3.5M4 4h12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  receipt:  '<svg viewBox="0 0 20 20" fill="none"><path d="M5 2.5h10v14.6l-2-1.2-1.5 1.2-1.5-1.2-1.5 1.2-1.5-1.2-2 1.2V2.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7.3 7h5.4M7.3 9.8h5.4M7.3 12.6h3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  building: '<svg viewBox="0 0 20 20" fill="none"><rect x="4" y="3" width="12" height="14" rx="1.6" stroke="currentColor" stroke-width="1.7"/><path d="M7.5 7h1M11.5 7h1M7.5 10h1M11.5 10h1M8.5 17v-3h3v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  user:     '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="7" r="3.2" stroke="currentColor" stroke-width="1.7"/><path d="M3.8 16.5c.8-3 3.2-4.5 6.2-4.5s5.4 1.5 6.2 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  check:    '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7.2" stroke="currentColor" stroke-width="1.7"/><path d="M6.8 10.2l2.2 2.2 4.2-4.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock:    '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7.2" stroke="currentColor" stroke-width="1.7"/><path d="M10 5.8V10l2.8 1.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lock:     '<svg viewBox="0 0 20 20" fill="none"><rect x="4.5" y="9" width="11" height="8" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M7 9V6.8a3 3 0 016 0V9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  layers:   '<svg viewBox="0 0 20 20" fill="none"><path d="M10 3l7 3.8-7 3.8-7-3.8L10 3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M3 10.2l7 3.8 7-3.8M3 13.4l7 3.8 7-3.8" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>',
};
function kpiIconFor(label){
  const l = String(label).toLowerCase();
  if (/payable|outstanding/.test(l)) return KPI_SVG.clock;
  if (/cash in hand/.test(l)) return KPI_SVG.wallet;
  if (/opening|closing/.test(l)) return KPI_SVG.lock;
  if (/cash out|returned/.test(l)) return KPI_SVG.outflow;
  if (/received|cash in/.test(l)) return KPI_SVG.inflow;
  if (/reimbursed/.test(l)) return KPI_SVG.check;
  if (/employee/.test(l)) return KPI_SVG.user;
  if (/company/.test(l)) return KPI_SVG.building;
  if (/expense|amount/.test(l)) return KPI_SVG.receipt;
  return KPI_SVG.layers;
}
function kpiCard({ label, value, sub, cls = '', onclick = '', big = false, icon = '' }){
  const ic = icon || kpiIconFor(label);
  const chip = cls.includes('positive') ? 'chip-green' : cls.includes('warning') ? 'chip-violet' : cls.includes('negative') ? 'chip-rose' : cls.includes('info') ? 'chip-sky' : 'chip-glass';
  const v = num(value);
  return `<div class="kpi ${cls} ${onclick?'clickable':''} ${big?'big':''}" ${onclick?`onclick="${onclick}" tabindex="0"`:''}>
    <div class="kpi-top"><div class="label">${label}</div><div class="chip ${chip}">${ic}</div></div>
    <div class="value count ${v<0?'is-neg':''}" data-v="${v}">${formatBDT(v)}</div>${sub?`<div class="sub">${sub}</div>`:''}
  </div>`;
}
function ringCard({ label, pct, sub }){
  pct = Math.max(0, Math.min(100, Math.round(num(pct))));
  return `<div class="kpi ring-card">
    <div class="kpi-top"><div class="label">${label}</div></div>
    <div class="ring-row"><div class="value">${pct}%</div>
      <svg class="ring" viewBox="0 0 44 44"><circle class="ring-bg" cx="22" cy="22" r="18" pathLength="100"/><circle class="ring-fg" cx="22" cy="22" r="18" pathLength="100" style="--pct:${pct}"/><text x="22" y="25.6" text-anchor="middle">${pct}%</text></svg>
    </div>${sub?`<div class="sub">${sub}</div>`:''}
  </div>`;
}
function animateNumbers(root){
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll('.count[data-v]').forEach(el => {
    const to = parseFloat(el.dataset.v) || 0; if (!to) return;
    const dur = 850 + Math.min(500, Math.abs(to) / 2000), t0 = performance.now();
    el.textContent = formatBDT(0);
    const step = now => { const p = Math.min(1, (now - t0) / dur), k = 1 - Math.pow(1 - p, 3); el.textContent = formatBDT(to * k); if (p < 1) requestAnimationFrame(step); else el.textContent = formatBDT(to); };
    requestAnimationFrame(step);
  });
}
function postRender(){
  const c = $('content'); if (!c) return;
  if (animNext){
    c.querySelectorAll('.kpi').forEach((k, i) => k.style.setProperty('--i', i));
    [...c.children].forEach((k, i) => k.style.setProperty('--c', i));
    c.classList.remove('enter'); void c.offsetWidth; c.classList.add('enter');
    animateNumbers(c); animNext = false;
  } else c.classList.remove('enter');
}

/* =========================================================
   Features: cost funds, employee picker, requests, settings, avatar
   ========================================================= */
function navVisible(n){ if (!n) return false; if (n.any) return true; if (n.emp) return !canWrite(); if (n.admin) return isAdmin(); return canWrite(); }
function badgeFor(n){
  const c = n.id === 'users' ? pendingCount : n.id === 'requests' ? ((data && data.requests) || []).length : 0;
  return c ? `<span class="nav-badge">${c}</span>` : '';
}

/* ----- Cost fund chips ----- */
let costFundSel = '';
function renderFundChips(){
  const box = $('exp_fund_chips'); if (!box) return;
  const list = (data.costFunds || []);
  box.innerHTML = list.map(n => `<button type="button" class="chip-btn ${costFundSel === n ? 'on' : ''}" onclick="pickCostFund(${jsArg(n)})">${esc(n)}</button>`).join('')
    + `<button type="button" class="chip-btn ${costFundSel === '__OTHERS__' ? 'on' : ''}" onclick="pickCostFund('__OTHERS__')">Others</button>`
    + (canWrite() ? `<button type="button" class="chip-btn add" onclick="addCostFundPrompt()">+ Add</button>` : '');
  $('exp_fund_other_field').classList.toggle('hidden', costFundSel !== '__OTHERS__');
}
function pickCostFund(n){ costFundSel = n; renderFundChips(); if (n === '__OTHERS__') setTimeout(() => $('exp_fund_other').focus(), 30); }
function addCostFundPrompt(){
  const name = (prompt('New cost fund name (e.g. product / project):') || '').trim();
  if (!name) return;
  if ((data.costFunds || []).some(x => x.toLowerCase() === name.toLowerCase())){ alert('That cost fund already exists.'); return; }
  data.costFunds.push(name); saveData(); pickCostFund(name);
}
function getCostFund(){ return costFundSel === '__OTHERS__' ? $('exp_fund_other').value.trim() : costFundSel; }
function setCostFundFor(e){
  const v = e ? e.costFund : '';
  $('exp_fund_other').value = '';
  if (v && !(data.costFunds || []).includes(v)){ costFundSel = '__OTHERS__'; $('exp_fund_other').value = v; }
  else costFundSel = v || '';
  renderFundChips();
}

/* ----- Employee picker (group members as clickable chips) ----- */
function pickEmployee(n){ $('exp_employee').value = n; renderEmployeeChips(); updateExpensePreview(); }
function renderEmployeeChips(){
  const box = $('exp_employee_chips'); if (!box) return;
  const cur = $('exp_employee').value;
  box.innerHTML = [...$('exp_employee').options].map(o => `<button type="button" class="chip-btn ${o.value === cur ? 'on' : ''}" onclick="pickEmployee(${jsArg(o.value)})">${esc(o.value)}</button>`).join('') || '<span class="muted">No team members yet.</span>';
}
function refreshEmployeeDropdown(selectValue){
  const names = members.map(m => m.name);
  if (selectValue && !names.includes(selectValue)) names.push(selectValue);
  const sel = $('exp_employee');
  sel.innerHTML = names.map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
  sel.value = selectValue && names.includes(selectValue) ? selectValue : (names[0] || '');
  renderEmployeeChips();
}
function applyRoleToExpenseModal(){
  const w = canWrite();
  $('exp_paidby_field').classList.toggle('hidden', !w);
  if (!w){
    document.querySelector('input[name="exp_paidby"][value="EMPLOYEE"]').checked = true;
    refreshEmployeeDropdown(me.name);
    $('exp_employee_field').classList.add('hidden');
    $('expenseModalTitle').textContent = 'Request Expense';
    $('expenseSaveBtn').textContent = 'Send Request';
    updateExpensePreview();
  }
}

/* ----- Cash check: block when company cash is short ----- */
function checkCashOrBlock(need){
  const cash = cashBalance();
  if (round2(cash - need) >= 0) return true;
  const short = round2(need - Math.max(0, cash));
  alert(`Cash in Hand is only ${formatBDT(cash)}. Short by ${formatBDT(short)}. Not saved.\n\nSave the ${formatBDT(Math.max(0, cash))} here as Company Fund, then add the ${formatBDT(short)} as a separate expense with "Employee (Own Pocket)". Or add money to Company Funds first.`);
  return false;
}
function fundSummaryHtml(list){
  const t = {}; list.forEach(e => { const k = e.costFund || 'Unassigned'; t[k] = (t[k] || 0) + num(e.amount); });
  const keys = Object.keys(t).sort((a, b) => t[b] - t[a]);
  if (!keys.length) return '';
  return `<div class="card fund-sum"><div style="font-weight:700;margin-bottom:8px;">Spending by Cost Fund</div><div class="chips">${keys.map(k => `<span class="fund-pill"><b>${esc(k)}</b> ${formatBDT(t[k])}</span>`).join('')}</div></div>`;
}

/* ----- Requests (admin/finance) ----- */
function approveRequest(id){
  const i = data.requests.findIndex(x => x.id === id); if (i < 0) return;
  const e = data.requests.splice(i, 1)[0]; e.status = 'APPROVED'; data.expenses.push(e);
  saveData(); toast('Approved. Added to books.'); render();
}
function rejectRequest(id){
  const e = data.requests.find(x => x.id === id); if (!e) return;
  if (!confirm(`Reject request "${e.description || e.category}" (${formatBDT(e.amount)}) from ${e.employee}? It will be deleted.`)) return;
  data.requests = data.requests.filter(x => x.id !== id); saveData(); toast('Request rejected.'); render();
}
function photoLink(e){ return e.photo ? `<a href="${e.photo}" target="_blank" rel="noopener">📎 View</a>` : '<span class="muted">—</span>'; }
function renderRequests(){
  const list = [...data.requests].sort(byDateDesc);
  const total = sumBy(list, e => e.amount);
  const rows = list.length ? list.map(e => `<tr>
    <td style="white-space:nowrap;">${formatDate(e.date)}</td><td><b>${esc(e.employee || '—')}</b></td>
    <td>${e.costFund ? `<span class="tag">${esc(e.costFund)}</span>` : '—'}</td><td>${esc(e.category)}</td>
    <td style="max-width:220px;">${esc(e.description || '—')}${e.notes ? `<div class="muted" style="font-size:11.5px;">${esc(e.notes)}</div>` : ''}</td>
    <td>${photoLink(e)}</td><td class="num"><b>${formatBDT(e.amount)}</b></td>
    <td><div class="row" style="gap:6px;flex-wrap:nowrap;"><button class="btn sm success" onclick="approveRequest('${e.id}')">Approve</button><button class="btn sm danger" onclick="rejectRequest('${e.id}')">Reject</button></div></td></tr>`).join('')
    : `<tr><td colspan="8" class="empty">No pending requests.</td></tr>`;
  return `<div class="page-head"><div><h1>Expense Requests</h1><p class="subtitle" style="margin-bottom:0;">Team members send expenses here. Approve to add them to the books (employee-paid, reimbursable).</p></div></div>
    <div class="kpi-grid">${kpiCard({ label:'Requested Amount', value:total, cls:'warning', icon:KPI_SVG.clock, sub:`${list.length} waiting for approval` })}</div>
    <div class="card" style="padding:0;overflow-x:auto;"><table><thead><tr><th>Date</th><th>By</th><th>Cost Fund</th><th>Category</th><th>Description</th><th>Receipt</th><th class="num">Amount</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* ----- Employee view ----- */
function renderMine(){
  const rows = [...data.mine].sort(byDateDesc);
  const appr = rows.filter(e => e.status === 'APPROVED'), pend = rows.filter(e => e.status === 'PENDING');
  const total = sumBy(appr, e => e.amount), got = sumBy(appr, e => sumBy(e.payments || [], p => p.amount));
  const due = Math.max(0, round2(total - got)), pendAmt = sumBy(pend, e => e.amount);
  const body = rows.length ? rows.map(e => {
    const paid = sumBy(e.payments || [], p => p.amount), left = round2(e.amount - paid);
    const st = e.status === 'PENDING' ? '<span class="badge-status badge-pending">Pending approval</span>'
      : left <= 0 ? '<span class="badge-status badge-reimbursed">Received</span>'
      : paid > 0 ? `<span class="badge-status badge-partial">Partly received</span><div class="amber" style="font-size:11.5px;margin-top:3px;">Due ${formatBDT(left)}</div>`
      : `<span class="badge-status badge-partial">Approved</span><div class="amber" style="font-size:11.5px;margin-top:3px;">You get ${formatBDT(left)}</div>`;
    return `<tr><td style="white-space:nowrap;">${formatDate(e.date)}</td><td>${e.costFund ? `<span class="tag">${esc(e.costFund)}</span>` : '—'}</td><td>${esc(e.category)}</td>
      <td style="max-width:220px;">${esc(e.description || '—')}${e.photo ? ' 📎' : ''}</td><td class="num"><b>${formatBDT(e.amount)}</b></td><td>${st}</td></tr>`;
  }).join('') : `<tr><td colspan="6" class="empty">No expenses yet. Tap "+ Request Expense".</td></tr>`;
  return `<div class="page-head"><div><h1>My Expenses</h1><p class="subtitle" style="margin-bottom:0;">Your own costs and how much you will get back. New expenses go to admin for approval.</p></div>
    <div class="actions"><button class="btn" onclick="openExpenseModal()">+ Request Expense</button></div></div>
    <div class="kpi-grid">
      ${kpiCard({ label:'Approved Cost', value:total, cls:'negative', sub:`${appr.length} approved` })}
      ${kpiCard({ label:'Received', value:got, cls:'positive', icon:KPI_SVG.check, sub:'Already reimbursed' })}
      ${kpiCard({ label:'You Will Get', value:due, cls:'warning', icon:KPI_SVG.clock, sub:'Still to receive' })}
      ${kpiCard({ label:'Pending Requests', value:pendAmt, cls:'info', icon:KPI_SVG.layers, sub:`${pend.length} waiting` })}
    </div>
    <div class="card" style="padding:0;overflow-x:auto;"><table><thead><tr><th>Date</th><th>Cost Fund</th><th>Category</th><th>Description</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ----- Settings + avatar ----- */
function applyAvatar(){
  ['topbar_avatar', 'mobile_avatar', 'set_avatar'].forEach(id => {
    const el = $(id); if (!el) return;
    if (me.avatarUrl){ el.style.backgroundImage = `url("${me.avatarUrl}")`; el.style.backgroundSize = 'cover'; el.style.backgroundPosition = 'center'; el.textContent = ''; }
    else { el.style.backgroundImage = ''; el.textContent = (me.name || '?').trim().slice(0, 1).toUpperCase(); }
  });
}
async function loadAvatar(){
  me.avatarUrl = null;
  if (me.avatarPath){ const { data: s } = await sb.storage.from(BUCKET).createSignedUrl(me.avatarPath, 3600); if (s) me.avatarUrl = s.signedUrl; }
  applyAvatar();
}
async function uploadAvatar(ev){
  const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
  if (!String(f.type).startsWith('image/')){ toast('Choose an image file.', 'err'); return; }
  if (f.size > 3 * 1024 * 1024){ toast('Image must be under 3 MB.', 'err'); return; }
  const path = `avatars/${me.id}/${Date.now()}-${safeName(f.name)}`;
  const up = await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type, upsert: false });
  if (up.error){ toast('Upload failed: ' + up.error.message, 'err'); return; }
  const r = await sb.rpc('fin_set_avatar', { p_path: path });
  if (r.error){ toast('Could not save: ' + r.error.message, 'err'); return; }
  const old = me.avatarPath; me.avatarPath = path; await loadAvatar();
  if (old) sb.storage.from(BUCKET).remove([old]).catch(() => {});
  toast('Photo updated.');
}
async function removeAvatar(){
  const old = me.avatarPath; if (!old) return;
  const r = await sb.rpc('fin_set_avatar', { p_path: null });
  if (r.error){ toast(r.error.message, 'err'); return; }
  me.avatarPath = null; me.avatarUrl = null; applyAvatar();
  sb.storage.from(BUCKET).remove([old]).catch(() => {});
  toast('Photo removed.');
}
function renderSettings(){
  return `<div class="page-head"><div><h1>Settings</h1><p class="subtitle" style="margin-bottom:0;">Your profile and security.</p></div></div>
    <div class="card" style="display:flex;gap:22px;align-items:center;flex-wrap:wrap;">
      <div class="avatar" id="set_avatar" style="width:92px;height:92px;font-size:36px;border-radius:26px;">${esc((me.name || '?').slice(0, 1).toUpperCase())}</div>
      <div style="flex:1;min-width:220px;"><div style="font-size:20px;font-weight:800;">${esc(me.name)}</div>
        <div class="muted">${esc(me.email || '')}</div><div class="muted">${esc(ROLE_LABEL[me.role] || me.role)} · @${esc(me.username)}</div>
        <div class="row" style="gap:8px;margin-top:12px;"><button class="btn sm" onclick="$('avatar_file').click()">Upload photo</button>${me.avatarPath ? '<button class="btn sm secondary" onclick="removeAvatar()">Remove</button>' : ''}</div>
        <input type="file" id="avatar_file" accept="image/*" class="hidden" onchange="uploadAvatar(event)"></div>
    </div>
    <div class="card" style="margin-top:18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;justify-content:space-between;">
      <div><div style="font-weight:700;">Password</div><div class="muted" style="font-size:13px;">Change the password you use to sign in.</div></div>
      <button class="btn secondary" onclick="openModal('changePasswordModal')">Change Password</button>
    </div>
    <div class="card" style="margin-top:18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;justify-content:space-between;">
      <div><div style="font-weight:700;">Sign out</div><div class="muted" style="font-size:13px;">Log out of this device.</div></div>
      <button class="btn outline" onclick="handleLogout()">Logout</button>
    </div>`;
}
