// The sized operating point, shared across components: the Sizer writes it while it
// has a solution, the chart panels read it to draw a reference mark at the bound
// gm/ID. One nullable number — deliberately not the whole report.

export const sizeMark = $state<{ gmId: number | null }>({ gmId: null });
