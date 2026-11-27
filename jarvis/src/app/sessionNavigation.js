/** 即使初始空会话无需换ID，“新建”也代表用户已主动离开自动恢复目标。 */
export function noteSessionNavigation(app) {
  app.sessionNavigationVersion = (Number.isSafeInteger(app.sessionNavigationVersion) ? app.sessionNavigationVersion : 0) + 1;
}

export function createNewSessionAction(app, { create, focus }) {
  return () => {
    noteSessionNavigation(app);
    if (!app.history.length) {
      focus();
      return;
    }
    app.switchTo(create());
    focus();
  };
}
