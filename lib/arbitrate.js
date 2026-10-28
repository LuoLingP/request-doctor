// 路由冲突的报告。
//
// 两个插件可能声明同一个 LLM provider id。registerAdapter 是"要么全成要么都不成"，
// 第二个来注册的直接抛 DUPLICATE_ADAPTER。这事值得告诉用户，但**不该由本插件替他们
// 做决定**——该停掉别人的哪个插件，是人家自己的事，不是一个修复工具该操心的。
//
// 所以这个模块只描述现状：不停用、不启用、不卸载、不改配置。
/** 把某个插件声明的路由拆成"别人已经在提供"和"只有它在提供"两组。 */
export function routeCoverage(providers, roster, selfName) {
  const served = new Set();
  for (const holder of roster ?? []) {
    if (holder.name === selfName) continue;
    for (const provider of holder.providers ?? []) served.add(provider);
  }
  const all = [...new Set(providers ?? [])];
  return {
    covered: all.filter((id) => served.has(id)),
    uncovered: all.filter((id) => !served.has(id)),
  };
}

// 描述一个插件的路由冲突情况，纯只读。
//
// 这个区分对使用者有意义：完全被覆盖的是纯重复品，部分覆盖的还握着独有能力，
// 两种情况该做什么决定是不一样的。
export function describeContention(input) {
  const contested = [...new Set(input.conflicts ?? [])];
  if (contested.length === 0) {
    return { contested: [], covered: [], uncovered: [], duplicateOf: [], note: 'no contested route' };
  }
  const { covered, uncovered } = routeCoverage(input.providers, input.roster, input.name);
  const duplicateOf = (input.roster ?? [])
    .filter((holder) => holder.name !== input.name)
    .filter((holder) => (holder.providers ?? []).some((id) => contested.includes(id)))
    .map((holder) => holder.name);

  // 说明它到底是"纯重复"还是"另有独家能力"，这两句话对用户的提示完全不同。
  let note;
  if (uncovered.length === 0) {
    note = `every route it declares is already served by ${duplicateOf.join(', ') || 'another plugin'}; it is a duplicate and needs no exemption to be useful`;
  } else {
    note = `it also owns ${uncovered.join(', ')}, which no other enabled plugin provides`;
  }
  return { contested, covered, uncovered, duplicateOf, note };
}
