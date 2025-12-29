async function viewDetail(id) {
  const res = await fetch(`/api/accounting/${id}`, {
    headers: { Authorization: `Bearer ${getToken()}` }
  });
  const data = await res.json();
  alert(JSON.stringify(data.record, null, 2));
}
