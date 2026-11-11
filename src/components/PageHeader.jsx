// Navigation belongs to the caller; subpages share the bar's layout and type.
export function PageHeader({
  title,
  titleId,
  titleTag: Title = "h1",
  back,
  actions,
  className = "",
  ...props
}) {
  return (
    <header class={`page-header ${className}`} {...props}>
      {back}
      {title != null && (
        <Title id={titleId} class="page-header-title">
          {title}
        </Title>
      )}
      {actions && <div class="header-actions">{actions}</div>}
    </header>
  );
}
