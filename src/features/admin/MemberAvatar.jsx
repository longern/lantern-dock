export function MemberAvatar({ member }) {
  const initial = Array.from(member.name.trim() || member.sub)[0];
  return (
    <span class="admin-member-avatar" aria-hidden="true">
      {initial.toUpperCase()}
    </span>
  );
}
