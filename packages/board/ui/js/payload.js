// issues.update merges the patch over the stored issue, so absent keys keep
// their stored value. The body must therefore be omitted unless it was
// actually loaded — sending '' for a never-fetched body would erase the
// description on disk.
export function issueUpdatePayload(issue) {
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    labels: issue.labels,
    project: issue.project,
    assignee: issue.assignee,
    dueDate: issue.dueDate || undefined,
    remindAt: issue.remindAt || undefined,
    body: typeof issue.body === 'string' ? issue.body : undefined,
  }
}
