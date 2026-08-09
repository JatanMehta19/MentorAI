import type { StudentProfile } from '../types.ts';

interface SidebarOptions {
  profile: StudentProfile | null;
  currentPage: string;
  isOnline: boolean;
  onNavigate: (page: string) => void;
}

function getLevelFromXP(xp: number): number {
  return Math.floor(xp / 200) + 1;
}

export function renderSidebar(options: SidebarOptions): HTMLElement {
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';
  
  const nickname = options.profile?.nickname ?? 'Student';
  const initials = nickname.substring(0, 2).toUpperCase();
  const totalXP = options.profile?.totalXP ?? 0;
  const currentLevel = getLevelFromXP(totalXP);
  
  const navItems = [
    { id: 'dashboard', icon: '🏠', label: 'Dashboard' },
    { id: 'math', icon: '➕', label: 'Math' },
    { id: 'ela', icon: '📖', label: 'ELA' },
    { id: 'progress', icon: '📈', label: 'Progress' },
    { id: 'settings', icon: '⚙️', label: 'Settings' },
  ];

  sidebar.innerHTML = `
    <div class="sidebar-logo">
      <div class="sidebar-logo-icon">M</div>
      <div class="sidebar-logo-text">MentorAI</div>
    </div>
    
    <nav class="sidebar-nav">
      ${navItems.map(item => `
        <button class="nav-item ${options.currentPage === item.id ? 'active' : ''}" data-page="${item.id}" data-route="${item.id}">
          <span class="nav-icon">${item.icon}</span>
          <span>${item.label}</span>
        </button>
      `).join('')}
    </nav>
    
    <div class="sidebar-footer">
      <div class="student-avatar">${initials}</div>
      <div class="student-info">
        <div class="student-name">${nickname}</div>
        <div class="student-level">
          <span class="level-dot" data-is-online="${options.isOnline}"></span>
          Level ${currentLevel} · ${options.isOnline ? 'Online' : 'Offline'}
        </div>
      </div>
    </div>
  `;

  const navButtons = sidebar.querySelectorAll('.nav-item');
  navButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLButtonElement;
      const page = target.dataset.page;
      if (page) {
        options.onNavigate(page);
      }
    });
  });

  return sidebar;
}

export function showSidebar(options: SidebarOptions): HTMLElement {
  return renderSidebar(options);
}