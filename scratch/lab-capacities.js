// Paste into the browser console on the Resource Booker, AFTER signing in and
// after clicking something in the app (typing in the resource search box is
// enough) so the app has made at least one request of its own.
//
// It prints a table of room name -> capacity for Belfast's computing labs.
// It never reads the token: it copies the headers the app already set.

(async () => {
  if (!window.__p) {
    window.__p = true;
    const o = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      this.__h = this.__h || {}; this.__h[k] = v; window.__lastHeaders = this.__h;
      return o.call(this, k, v);
    };
    console.log('Headers hooked. Now click something in the app (type in the search box), then run this again.');
    return;
  }
  if (!window.__lastHeaders) {
    console.log('No headers captured yet — type something in the resource search box, then run this again.');
    return;
  }

  const API = 'https://scientia-eu-v4-api-d6-01.azurewebsites.net/api/';
  const bt = location.pathname.split('/booking-types/')[1].split('/')[0];
  const H = () => Object.assign({}, window.__lastHeaders);

  const post = async (path, body) => {
    const h = H(); h['Content-Type'] = 'application/json';
    const r = await fetch(API + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
    return r.json();
  };
  const get = async (path) => {
    const h = H(); delete h['Content-Type'];
    const r = await fetch(API + path, { headers: h });
    return r.json();
  };

  // The rooms we need a seat count for.
  const WANTED = [
    'BC-02-303', 'BC-03-303', 'BC-03-305', 'BC-03-307', 'BC-03-308',
    'BC-03-309', 'BC-03-311', 'BC-05-306',
    'BA-03-024', 'BA-03-026', 'BC-01-308', 'BC-02-426', 'BC-03-302',
  ];

  const list = await post(
    `BookingTypes/${bt}/BookableResourceGroupsAndResources`,
    { Query: 'B_BC-0', ItemsPerPage: 1000, Properties: [], ResourceGroupIdentities: [], LoadedIdentities: [] });
  const list2 = await post(
    `BookingTypes/${bt}/BookableResourceGroupsAndResources`,
    { Query: 'B_BA-0', ItemsPerPage: 1000, Properties: [], ResourceGroupIdentities: [], LoadedIdentities: [] });
  const all = [...(list.Resources || []), ...(list2.Resources || [])];

  const hits = all.filter(r => WANTED.some(w => r.Name.includes(w)));
  console.log(`Found ${hits.length} of ${WANTED.length} rooms; fetching capacities...`);

  const out = [];
  for (const r of hits) {
    try {
      const d = await get(`BookingTypes/${bt}/Resources/${r.Identity}`);
      const props = d.Properties || [];
      const cap = props.find(p => /capacity/i.test(p.Name || ''));
      const desc = props.find(p => /description/i.test(p.Name || ''));
      out.push({ room: r.Name, capacity: cap ? cap.Value : '(none)', description: desc ? desc.Value : '' });
    } catch (e) {
      out.push({ room: r.Name, capacity: 'ERROR ' + e.message, description: '' });
    }
    await new Promise(s => setTimeout(s, 120));
  }
  console.table(out);
  // Copyable, to paste back into the conversation.
  console.log(out.map(o => `${o.room}\t${o.capacity}\t${o.description}`).join('\n'));
})();
