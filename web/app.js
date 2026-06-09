// ===== Auth Guard =====
// Read session before anything else
const _sessionRole = sessionStorage.getItem('ayt_role');
const _sessionName = sessionStorage.getItem('ayt_username');
const _sessionRoleLabel = sessionStorage.getItem('ayt_user_role_label');

if (!_sessionRole) {
  // Not logged in — redirect to login page
  window.location.replace('login.html');
}

const currentUserRole = _sessionRole || 'hr'; // 'hr' | 'tester' | 'developer'
const isHR = currentUserRole === 'hr';

// ===== State Management =====
// state.profile is the ADMIN's profile (stored in DB).
// For display, we always use session data (_sessionName, _sessionRoleLabel) so each role sees their own name.
let state = {
  projects: [],
  testers: [],
  profile: {
    name: '',
    role: 'Admin',
    avatar: '' // Base64 data URL
  },
  notifications: [],
  bugs: [], // Array of bug objects
  theme: 'dark'
};

// ===== MongoDB API Layer =====
// All DB operations go through /api/db (Vercel serverless → MongoDB Atlas).
// No credentials needed on the frontend — they live in Vercel env vars.
let dbOnline = false; // Set to true once a successful API call confirms MongoDB is connected

// ── Fetch all data from MongoDB ──────────────────────────────────────────────
async function fetchCloudData() {
  try {
    const res = await fetch('/api/db', { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();

    if (data.offline) {
      console.warn('MongoDB not configured on server:', data.message);
      return false;
    }

    // Merge fetched data into state
    if (Array.isArray(data.projects))      state.projects      = data.projects;
    if (Array.isArray(data.testers))       state.testers       = data.testers;
    if (Array.isArray(data.bugs)) {
      state.bugs = data.bugs.map(b => ({
        ...b,
        comments: Array.isArray(b.comments) ? b.comments : (typeof b.comments === 'string' ? JSON.parse(b.comments) : [])
      }));
    }
    if (Array.isArray(data.notifications)) {
      state.notifications = data.notifications.sort((a, b) => b.id.localeCompare(a.id));
    }
    if (data.profile && isHR) {
      state.profile = { name: data.profile.name || '', role: data.profile.role || 'Admin', avatar: data.profile.avatar || '' };
    }

    dbOnline = true;
    saveStateLocal(); // Cache locally
    return true;
  } catch (err) {
    console.error('fetchCloudData error:', err);
    return false;
  }
}

// ── Upsert a single record — ALWAYS attempts write, no dbOnline gate ────────
async function syncItemToCloud(table, item) {
  try {
    const res = await fetch('/api/db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'upsert', table, data: item })
    });
    if (res.ok) dbOnline = true; // Mark online after first successful write
  } catch (err) {
    console.warn(`syncItemToCloud [${table}] error:`, err);
  }
}

// ── Delete a single record — ALWAYS attempts, no dbOnline gate ───────────────
async function deleteItemFromCloud(table, id) {
  try {
    await fetch('/api/db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', table, id })
    });
  } catch (err) {
    console.warn(`deleteItemFromCloud [${table}] error:`, err);
  }
}

// ── Bulk sync: push all local state to MongoDB ───────────────────────────────
async function syncAllLocalDataToCloud() {
  showToast('Syncing all data to MongoDB...', 'info');
  try {
    const allItems = [
      { table: 'profile', data: [{ id: 'hr_manager', ...state.profile }] },
      { table: 'testers',       data: state.testers },
      { table: 'projects',      data: state.projects },
      { table: 'bugs',          data: state.bugs },
      { table: 'notifications', data: state.notifications }
    ];
    for (const { table, data } of allItems) {
      for (const item of data) {
        await syncItemToCloud(table, item);
      }
    }
    showToast('All data synced to MongoDB!', 'success');
  } catch (err) {
    showToast('Bulk sync failed: ' + err.message, 'error');
  }
}



// (Supabase SQL schema removed — using MongoDB now)

// Global Chart References
let statusChartInstance = null;
let workloadChartInstance = null;
let priorityChartInstance = null;

// Navigation Tracking
let currentPage = 'dashboard';
let previousPage = 'dashboard';
let activeDetailProjectId = null;

// Temporary storages for file uploads
let tempAvatarBase64 = '';
let tempBugScreenshotBase64 = '';

// Active Bug filters
let activeBugFilter = 'all';

// ===== State Persistence =====

// Save only to localStorage (fast, synchronous)
function saveStateLocal() {
  localStorage.setItem('adiyogi_bug_tracker_state', JSON.stringify(state));
}

// saveState = localStorage (MongoDB writes happen per-item via syncItemToCloud)
function saveState() {
  saveStateLocal();
}

function loadState() {
  const saved = localStorage.getItem('adiyogi_bug_tracker_state');
  if (saved) {
    try {
      state = JSON.parse(saved);
      if (!state.bugs)          state.bugs = [];
      if (!state.testers)       state.testers = [];
      if (!state.projects)      state.projects = [];
      if (!state.notifications) state.notifications = [];
      if (!state.profile)       state.profile = { name: '', role: 'Admin', avatar: '' };
    } catch (e) {
      console.error('Failed to parse saved state:', e);
      initializeDefaults();
    }
  } else {
    initializeDefaults();
  }
}

function initializeDefaults() {
  state.theme = 'dark';
  state.profile = { name: '', role: 'Admin', avatar: '' };
  state.testers = [];
  state.projects = [];
  state.notifications = [
    { id: 'n1', type: 'info', text: 'Welcome to Adiyogi Bug Tracker! Data syncs globally via MongoDB.', time: 'Just now', read: false }
  ];
  state.bugs = [];
  saveStateLocal();
}

async function fetchCloudData() {
  if (!supabaseClient) return false;
  try {
    // 1. Fetch Profile (Admin profile stored in DB)
    // state.profile holds the ADMIN's profile from DB. renderProfile() uses session data for display.
    if (isHR) {
      const { data: profileData, error: profileErr } = await supabaseClient.from('profile').select('*');
      if (!profileErr && profileData && profileData.length > 0) {
        const p = profileData[0];
        state.profile = {
          name: p.name,
          role: p.role,
          avatar: p.avatar || ''
        };
      }
    }

    // 2. Fetch Testers
    const { data: testersData, error: testersErr } = await supabaseClient.from('testers').select('*');
    if (!testersErr && testersData) {
      state.testers = testersData;
    }

    // 3. Fetch Projects
    const { data: projectsData, error: projectsErr } = await supabaseClient.from('projects').select('*');
    if (!projectsErr && projectsData) {
      state.projects = projectsData;
    }

    // 4. Fetch Bugs
    const { data: bugsData, error: bugsErr } = await supabaseClient.from('bugs').select('*');
    if (!bugsErr && bugsData) {
      state.bugs = bugsData.map(b => ({
        ...b,
        comments: typeof b.comments === 'string' ? JSON.parse(b.comments) : (b.comments || [])
      }));
    }

    // 5. Fetch Notifications
    const { data: notifData, error: notifErr } = await supabaseClient.from('notifications').select('*');
    if (!notifErr && notifData) {
      state.notifications = notifData.sort((a, b) => {
        // Sort newest notifications first
        return b.id.localeCompare(a.id);
      });
    }

    saveState(); // Update local storage cache
    return true;
  } catch (err) {
    console.error('Error fetching cloud database contents:', err);
    return false;
  }
}

async function syncItemToCloud(table, item) {
  if (!supabaseClient) return;
  try {
    // Clone item to serialize comments properly if table is bugs
    let uploadItem = { ...item };
    if (table === 'bugs' && typeof uploadItem.comments === 'object') {
      // Supabase JS handles objects, but we can structure it safely
      uploadItem.comments = uploadItem.comments;
    }

    const { error } = await supabaseClient.from(table).upsert(uploadItem);
    if (error) {
      console.error(`Supabase Upsert Error [${table}]:`, error);
    }
  } catch (err) {
    console.error(`Failed to push item to Supabase [${table}]:`, err);
  }
}

async function deleteItemFromCloud(table, id) {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient.from(table).delete().eq('id', id);
    if (error) {
      console.error(`Supabase Delete Error [${table}]:`, error);
    }
  } catch (err) {
    console.error(`Failed to delete item from Supabase [${table}]:`, err);
  }
}

// Bulk Sync Local cache to Cloud database
async function syncAllLocalDataToCloud() {
  if (!supabaseClient) {
    showToast('Database not connected', 'error');
    return;
  }

  showToast('Starting cloud sync...', 'info');

  try {
    // 1. Sync Profile
    await supabaseClient.from('profile').upsert({ id: 'hr_manager', ...state.profile });

    // 2. Sync Testers
    if (state.testers.length > 0) {
      await supabaseClient.from('testers').upsert(state.testers);
    }

    // 3. Sync Projects
    if (state.projects.length > 0) {
      await supabaseClient.from('projects').upsert(state.projects);
    }

    // 4. Sync Bugs
    if (state.bugs.length > 0) {
      const serializedBugs = state.bugs.map(b => ({
        ...b,
        comments: b.comments // Supabase client auto serializes arrays
      }));
      await supabaseClient.from('bugs').upsert(serializedBugs);
    }

    // 5. Sync Notifications
    if (state.notifications.length > 0) {
      await supabaseClient.from('notifications').upsert(state.notifications);
    }

    showToast('Cloud Database Sync Completed!', 'success');
  } catch (err) {
    console.error('Error during bulk cloud sync:', err);
    showToast('Sync Failed: Check table schemas or permissions', 'error');
  }
}

// ===== Toast Notification System =====
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'info';
  if (type === 'success') icon = 'check_circle';
  if (type === 'error') icon = 'error';
  if (type === 'warning') icon = 'warning';

  toast.innerHTML = `
    <span class="material-icons-round">${icon}</span>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  // Animate slide-out and remove
  setTimeout(() => {
    toast.style.animation = 'toastIn .3s ease reverse forwards';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

// ===== Add Notification Helper =====
function addNotification(text, type = 'info') {
  const newNotif = {
    id: 'notif_' + Date.now(),
    type: type,
    text: text,
    time: 'Just now',
    read: false
  };
  state.notifications.unshift(newNotif);
  if (state.notifications.length > 20) {
    state.notifications.pop();
  }
  saveState();
  syncItemToCloud('notifications', newNotif);
  renderNotifications();
}

// ===== Theme Controller =====
function initTheme() {
  const body = document.body;
  const themeBtn = document.getElementById('themeToggle');
  
  if (state.theme === 'light') {
    body.classList.add('light-theme');
    if (themeBtn) themeBtn.innerHTML = '<span class="material-icons-round">light_mode</span>';
  } else {
    body.classList.remove('light-theme');
    if (themeBtn) themeBtn.innerHTML = '<span class="material-icons-round">dark_mode</span>';
  }
}

function toggleTheme() {
  const body = document.body;
  const themeBtn = document.getElementById('themeToggle');
  
  if (body.classList.contains('light-theme')) {
    body.classList.remove('light-theme');
    state.theme = 'dark';
    if (themeBtn) themeBtn.innerHTML = '<span class="material-icons-round">dark_mode</span>';
    showToast('Dark mode activated', 'info');
  } else {
    body.classList.add('light-theme');
    state.theme = 'light';
    if (themeBtn) themeBtn.innerHTML = '<span class="material-icons-round">light_mode</span>';
    showToast('Light mode activated', 'info');
  }
  saveState();
  renderCharts();
  const progressPercent = calculateProgressPercent();
  drawProgressRing(progressPercent);
}

// ===== Page Navigation =====
function switchPage(pageId) {
  if (pageId !== 'projectDetails') {
    previousPage = pageId;
  }
  currentPage = pageId;

  const navItems = document.querySelectorAll('.nav-item');
  const pages = document.querySelectorAll('.page');
  
  navItems.forEach(item => {
    if (item.getAttribute('data-page') === pageId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  pages.forEach(page => {
    if (page.id === `${pageId}Page`) {
      page.classList.add('active');
    } else {
      page.classList.remove('active');
    }
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Page specific renders
  if (pageId === 'dashboard') {
    const progressPercent = calculateProgressPercent();
    drawProgressRing(progressPercent);
    renderStats();
    renderRecentProjects();
    renderTimeline();
  } else if (pageId === 'projects') {
    renderProjectsTable();
  } else if (pageId === 'testers') {
    renderTesters();
  } else if (pageId === 'reports') {
    renderCharts();
  } else if (pageId === 'projectDetails') {
    renderProjectDetailsView(activeDetailProjectId);
  }
}

// ===== Render User Profile =====
// IMPORTANT: Always display the LOGGED-IN USER's name/role from session, not state.profile (admin's).
// state.profile is the admin's editable profile stored in DB.
// For non-admin users the sidebar/topbar must show their own session identity.
function renderProfile() {
  // Use session name/role for display — works for all roles
  const displayName = _sessionName || state.profile.name || 'User';
  const displayRole = _sessionRoleLabel || state.profile.role || 'Member';
  // Avatar: only admin has an editable avatar stored in state.profile
  const avatar = isHR ? (state.profile.avatar || '') : '';

  const initials = displayName.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);

  const sidebarName = document.getElementById('sidebarUserName');
  const sidebarRole = document.getElementById('sidebarUserRole');
  const sidebarAvatar = document.getElementById('sidebarUserAvatar');
  
  if (sidebarName) sidebarName.textContent = displayName;
  if (sidebarRole) sidebarRole.textContent = displayRole;

  const topName = document.getElementById('topUserName');
  const topAvatar = document.getElementById('topUserAvatar');

  if (topName) topName.textContent = displayName;

  if (avatar) {
    if (sidebarAvatar) {
      sidebarAvatar.classList.add('has-image');
      sidebarAvatar.style.backgroundImage = `url(${avatar})`;
    }
    if (topAvatar) {
      topAvatar.classList.add('has-image');
      topAvatar.style.backgroundImage = `url(${avatar})`;
    }
  } else {
    if (sidebarAvatar) {
      sidebarAvatar.classList.remove('has-image');
      sidebarAvatar.style.backgroundImage = '';
      sidebarAvatar.innerHTML = '<span class="material-icons-round">person</span>';
    }
    if (topAvatar) {
      topAvatar.classList.remove('has-image');
      topAvatar.style.backgroundImage = '';
      topAvatar.textContent = initials;
    }
  }
}

// ===== Render Notifications =====
function renderNotifications() {
  const list = document.getElementById('notifList');
  const badge = document.getElementById('notifBadge');
  if (!list) return;

  const unread = state.notifications.filter(n => !n.read).length;
  
  if (badge) {
    if (unread > 0) {
      badge.style.display = 'flex';
      badge.textContent = unread;
    } else {
      badge.style.display = 'none';
    }
  }

  if (state.notifications.length === 0) {
    list.innerHTML = `<div class="notif-empty">No new notifications</div>`;
    return;
  }

  list.innerHTML = state.notifications.map(n => {
    let dotColor = 'blue';
    if (n.type === 'success') dotColor = 'green';
    if (n.type === 'warning') dotColor = 'orange';
    if (n.type === 'error') dotColor = 'red';

    return `
      <div class="notif-item">
        <div class="notif-dot ${dotColor}"></div>
        <div class="notif-content">
          <p style="${!n.read ? 'font-weight: 600;' : ''}">${n.text}</p>
          <span>${n.time}</span>
        </div>
      </div>
    `;
  }).join('');
}

// ===== Project Form Options =====
function populateTesterSelect() {
  const select = document.getElementById('testerSelect');
  if (!select) return;

  select.innerHTML = '<option value="">Select a tester</option>' + 
    state.testers.map(t => `<option value="${t.id}">${t.name} (${t.role})</option>`).join('');
}

// ===== Project Modals CRUD =====
function openProjectModal(projectId = null) {
  populateTesterSelect();
  const modal = document.getElementById('projectModal');
  const modalTitle = document.getElementById('modalTitle');
  const form = document.getElementById('projectForm');
  
  if (!modal) return;

  if (projectId) {
    modalTitle.textContent = 'Edit Project';
    const project = state.projects.find(p => p.id === projectId);
    if (project) {
      document.getElementById('editProjectId').value = project.id;
      document.getElementById('projectName').value = project.name;
      document.getElementById('testerSelect').value = project.testerId;
      document.getElementById('prioritySelect').value = project.priority;
      document.getElementById('projectDesc').value = project.desc || '';
      document.getElementById('statusSelect').value = project.status;
      document.getElementById('projectTypeSelect').value = project.projectType || 'Both';
    }
  } else {
    modalTitle.textContent = 'Add New Project';
    form.reset();
    document.getElementById('editProjectId').value = '';
    document.getElementById('prioritySelect').value = 'Medium';
    document.getElementById('statusSelect').value = 'Pending';
    document.getElementById('projectTypeSelect').value = 'Both';
  }

  modal.classList.add('show');
}

function closeProjectModal() {
  const modal = document.getElementById('projectModal');
  if (modal) modal.classList.remove('show');
}

// Submit Project
document.getElementById('projectForm').addEventListener('submit', function(e) {
  e.preventDefault();

  const id = document.getElementById('editProjectId').value;
  const name = document.getElementById('projectName').value.trim();
  const testerId = document.getElementById('testerSelect').value;
  const priority = document.getElementById('prioritySelect').value;
  const desc = document.getElementById('projectDesc').value.trim();
  const status = document.getElementById('statusSelect').value;
  const projectType = document.getElementById('projectTypeSelect').value;

  if (!name || !testerId) {
    showToast('Please fill out all required fields.', 'error');
    return;
  }

  let finalProject = null;

  if (id) {
    const projectIndex = state.projects.findIndex(p => p.id === id);
    if (projectIndex > -1) {
      const oldStatus = state.projects[projectIndex].status;
      finalProject = {
        ...state.projects[projectIndex],
        name,
        testerId,
        priority,
        desc,
        status,
        projectType
      };
      state.projects[projectIndex] = finalProject;
      
      let statusLog = '';
      if (oldStatus !== status) statusLog = ` Status changed to ${status}.`;
      addNotification(`Project "${name}" updated.${statusLog}`, 'info');
      showToast('Project updated successfully!');
    }
  } else {
    finalProject = {
      id: 'proj_' + Date.now(),
      name,
      testerId,
      priority,
      status,
      projectType,
      desc,
      created: new Date().toISOString().split('T')[0]
    };
    state.projects.push(finalProject);
    addNotification(`New project "${name}" added. Assigned to tester.`, 'success');
    showToast('Project added successfully!');
  }

  saveState();
  if (finalProject) syncItemToCloud('projects', finalProject);
  closeProjectModal();
  renderAll();
});

// Delete Confirmation
let projectToDeleteId = null;

function confirmDeleteProject(projectId) {
  projectToDeleteId = projectId;
  const confirmModal = document.getElementById('confirmModal');
  const project = state.projects.find(p => p.id === projectId);
  if (confirmModal && project) {
    document.getElementById('confirmTitle').textContent = 'Delete Project';
    document.getElementById('confirmMessage').textContent = `Are you sure you want to delete "${project.name}"? This action cannot be undone.`;
    confirmModal.classList.add('show');
  }
}

document.getElementById('confirmOk').addEventListener('click', function() {
  if (projectToDeleteId) {
    const project = state.projects.find(p => p.id === projectToDeleteId);
    if (project) {
      state.projects = state.projects.filter(p => p.id !== projectToDeleteId);
      
      // Cascade delete bugs
      const deletedBugs = state.bugs.filter(b => b.projectId === projectToDeleteId);
      state.bugs = state.bugs.filter(b => b.projectId !== projectToDeleteId);
      
      addNotification(`Project "${project.name}" and its bugs were deleted.`, 'warning');
      showToast('Project deleted', 'info');
      saveState();
      
      // Sync deletes to cloud
      deleteItemFromCloud('projects', projectToDeleteId);
      deletedBugs.forEach(b => deleteItemFromCloud('bugs', b.id));
    }
    projectToDeleteId = null;
  }
  document.getElementById('confirmModal').classList.remove('show');
  renderAll();
});

document.getElementById('confirmCancel').addEventListener('click', function() {
  projectToDeleteId = null;
  document.getElementById('confirmModal').classList.remove('show');
});

// ===== Tester CRUD =====
function openTesterModal() {
  const modal = document.getElementById('testerModal');
  if (modal) modal.classList.add('show');
}

function closeTesterModal() {
  const modal = document.getElementById('testerModal');
  if (modal) {
    modal.classList.remove('show');
    document.getElementById('testerForm').reset();
  }
}

document.getElementById('testerForm').addEventListener('submit', function(e) {
  e.preventDefault();
  
  const name = document.getElementById('testerName').value.trim();
  const email = document.getElementById('testerEmail').value.trim();
  const role = document.getElementById('testerRole').value;

  if (!name) {
    showToast('Tester name is required', 'error');
    return;
  }

  const newTester = {
    id: 'test_' + Date.now(),
    name,
    email: email || 'No email provided',
    role
  };

  state.testers.push(newTester);
  saveState();
  syncItemToCloud('testers', newTester);
  addNotification(`New tester "${name}" added to the team.`, 'success');
  showToast('Tester added successfully!');
  closeTesterModal();
  renderAll();
});

function deleteTester(testerId) {
  const tester = state.testers.find(t => t.id === testerId);
  if (!tester) return;

  const assignedCount = state.projects.filter(p => p.testerId === testerId).length;
  if (assignedCount > 0) {
    showToast(`Cannot delete: Tester has ${assignedCount} active project assignments. Reassign projects first.`, 'error');
    return;
  }

  if (confirm(`Are you sure you want to remove tester "${tester.name}"?`)) {
    state.testers = state.testers.filter(t => t.id !== testerId);
    saveState();
    deleteItemFromCloud('testers', testerId);
    addNotification(`Tester "${tester.name}" removed from the team.`, 'warning');
    showToast('Tester removed', 'info');
    renderAll();
  }
}

// ===== Profile Modal Management =====
function openProfileModal() {
  const modal = document.getElementById('profileModal');
  const nameInput = document.getElementById('profileNameInput');
  const roleInput = document.getElementById('profileRoleInput');
  const preview = document.getElementById('profilePreviewAvatar');
  
  // Database Inputs
  const dbUrlInput = document.getElementById('dbUrlInput');
  const dbKeyInput = document.getElementById('dbKeyInput');
  const schemaSection = document.getElementById('dbSchemaSection');
  const schemaTextarea = document.getElementById('dbSqlCopyText');
  const syncBtn = document.getElementById('syncLocalToDbBtn');

  if (!modal) return;

  nameInput.value = state.profile.name;
  roleInput.value = state.profile.role;
  tempAvatarBase64 = state.profile.avatar;

  const initials = state.profile.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);

  if (tempAvatarBase64) {
    preview.classList.add('has-image');
    preview.style.backgroundImage = `url(${tempAvatarBase64})`;
  } else {
    preview.classList.remove('has-image');
    preview.style.backgroundImage = '';
    preview.textContent = initials;
  }

  // Populate DB Credentials from localStorage
  dbUrlInput.value = localStorage.getItem('adiyogi_supabase_url') || '';
  dbKeyInput.value = localStorage.getItem('adiyogi_supabase_key') || '';

  // Setup SQL Setup block
  schemaTextarea.value = DB_SQL_SCHEMA;
  schemaSection.style.display = 'block';

  if (supabaseClient) {
    syncBtn.style.display = 'block';
  } else {
    syncBtn.style.display = 'none';
  }

  modal.classList.add('show');
}

function closeProfileModal() {
  const modal = document.getElementById('profileModal');
  if (modal) modal.classList.remove('show');
  tempAvatarBase64 = '';
}

document.getElementById('changePhotoBtn').addEventListener('click', function() {
  document.getElementById('profileAvatarFile').click();
});

document.getElementById('profileAvatarFile').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) {
    showToast('File is too large. Max size is 2MB.', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = function(event) {
    tempAvatarBase64 = event.target.result;
    const preview = document.getElementById('profilePreviewAvatar');
    preview.classList.add('has-image');
    preview.style.backgroundImage = `url(${tempAvatarBase64})`;
  };
  reader.readAsDataURL(file);
});

// Submit Profile Form
document.getElementById('profileForm').addEventListener('submit', async function(e) {
  e.preventDefault();

  const name = document.getElementById('profileNameInput').value.trim();
  const role = document.getElementById('profileRoleInput').value.trim();

  if (!name) {
    showToast('Name is required', 'error');
    return;
  }

  state.profile.name = name;
  state.profile.role = role || 'Admin';
  state.profile.avatar = tempAvatarBase64;

  saveState();
  renderProfile();

  // Sync profile to MongoDB
  await syncItemToCloud('profile', { id: 'hr_manager', ...state.profile });
  dbOnline = true; // Mark as online after a successful write

  addNotification('User profile settings updated.', 'success');
  showToast('Profile updated successfully!');
  closeProfileModal();
  renderAll();
});

// ===== Project Details Page (Bugs Management) =====

function viewProjectDetails(projectId) {
  activeDetailProjectId = projectId;
  activeBugFilter = 'all';
  switchPage('projectDetails');
}

function renderProjectDetailsView(projectId) {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) {
    showToast('Project not found.', 'error');
    switchPage('dashboard');
    return;
  }

  const tester = state.testers.find(t => t.id === project.testerId);
  const testerName = tester ? tester.name : 'Unassigned';

  // Fill details fields
  document.getElementById('detailProjectName').textContent = project.name;
  document.getElementById('detailProjectDesc').textContent = project.desc || 'No description provided for this project.';
  document.getElementById('detailProjectTester').textContent = testerName;
  document.getElementById('detailProjectPriority').textContent = project.priority;
  document.getElementById('detailProjectStatus').textContent = project.status;

  // Calculate statistics
  let projectBugs = state.bugs.filter(b => b.projectId === projectId);
  if (currentUserRole === 'developer') {
    const devName = (_sessionName || '').trim().toLowerCase();
    projectBugs = projectBugs.filter(b => b.developer && b.developer.trim().toLowerCase() === devName);
  }
  const totalBugs = projectBugs.length;

  document.getElementById('detailProjectBugsCount').textContent = totalBugs;

  // Specific Bug Status Counts
  const pending = projectBugs.filter(b => b.status === 'Pending').length;
  const progress = projectBugs.filter(b => b.status === 'In Progress').length;
  const completed = projectBugs.filter(b => b.status === 'Done').length;
  const reopen = projectBugs.filter(b => b.status === 'Re-open').length;

  // Percentages
  const pendingPct = totalBugs ? Math.round((pending / totalBugs) * 100) : 0;
  const progressPct = totalBugs ? Math.round((progress / totalBugs) * 100) : 0;
  const completedPct = totalBugs ? Math.round((completed / totalBugs) * 100) : 0;
  const reopenPct = totalBugs ? Math.round((reopen / totalBugs) * 100) : 0;

  // Update percentages UI
  document.getElementById('pendingBugsCount').textContent = pending;
  document.getElementById('pendingBugsPercent').textContent = `${pendingPct}%`;
  
  document.getElementById('progressBugsCount').textContent = progress;
  document.getElementById('progressBugsPercent').textContent = `${progressPct}%`;
  
  document.getElementById('completedBugsCount').textContent = completed;
  document.getElementById('completedBugsPercent').textContent = `${completedPct}%`;
  
  document.getElementById('reopenBugsCount').textContent = reopen;
  document.getElementById('reopenBugsPercent').textContent = `${reopenPct}%`;

  // Render Bugs list
  renderProjectBugsList(projectId);
}

// Render Bugs List inside Project Details screen
function renderProjectBugsList(projectId) {
  const container = document.getElementById('projectBugsList');
  const emptyState = document.getElementById('bugEmptyState');
  if (!container) return;

  const searchQuery = document.getElementById('searchInput').value.toLowerCase().trim();
  const typeFilter = document.getElementById('bugTypeFilter').value;

  // Filter project bugs (role-based)
  let projectBugs = state.bugs.filter(b => b.projectId === projectId);
  if (currentUserRole === 'developer') {
    const devName = (_sessionName || '').trim().toLowerCase();
    projectBugs = projectBugs.filter(b => b.developer && b.developer.trim().toLowerCase() === devName);
  }

  // Apply Status Filter
  if (activeBugFilter !== 'all') {
    projectBugs = projectBugs.filter(b => b.status === activeBugFilter);
  }

  // Apply Type Filter
  if (typeFilter !== 'all') {
    projectBugs = projectBugs.filter(b => b.type === typeFilter);
  }

  // Apply Search Query
  if (searchQuery) {
    projectBugs = projectBugs.filter(b => 
      b.title.toLowerCase().includes(searchQuery) ||
      (b.desc && b.desc.toLowerCase().includes(searchQuery)) ||
      (b.developer && b.developer.toLowerCase().includes(searchQuery))
    );
  }

  if (projectBugs.length === 0) {
    container.innerHTML = '';
    if (emptyState) emptyState.style.display = 'block';
    return;
  }

  if (emptyState) emptyState.style.display = 'none';

  container.innerHTML = projectBugs.map((b, index) => {
    const seqNumber = index + 1;
    const typeClass = b.type.toLowerCase();
    const severityClass = b.severity.toLowerCase();
    const statusClass = b.status.toLowerCase().replace(' ', '-');

    const statusOptions = ['Pending', 'In Progress', 'Done', 'Re-open', 'In Future', 'No Need'];
    const selectOptions = statusOptions.map(opt => {
      const selected = b.status === opt ? 'selected' : '';
      return `<option value="${opt}" ${selected}>${opt}</option>`;
    }).join('');

    // Screenshot HTML
    let screenshotHtml = '';
    if (b.screenshot) {
      screenshotHtml = `
        <div class="bug-screenshot-thumbnail-container">
          <div class="bug-desc-header">Screenshot / Attachment</div>
          <img class="bug-screenshot-thumbnail" src="${b.screenshot}" onclick="openLightbox('${b.screenshot}')" alt="Bug Screenshot">
        </div>
      `;
    }

    // Comments list HTML
    const commentsListHtml = (b.comments || []).map(c => `
      <div class="comment-item">
        <div class="comment-header">
          <span class="comment-author">${c.author}</span>
          <span class="comment-time">${c.time}</span>
        </div>
        <div class="comment-body">${c.text}</div>
      </div>
    `).join('');

    return `
      <div class="bug-card" id="bugCard_${b.id}">
        <div class="bug-header" onclick="toggleBugDetails('${b.id}')">
          <span class="bug-index">#${seqNumber}</span>
          <div class="bug-title-text">${b.title}</div>
          <div class="bug-meta-tags">
            <span class="bug-type-tag ${typeClass}">${b.type}</span>
            <span class="bug-severity-badge ${severityClass}">${b.severity}</span>
            <select class="bug-status-inline-select bug-status-badge ${statusClass}" onchange="changeBugStatus('${b.id}', this.value); event.stopPropagation();">
              ${selectOptions}
            </select>
            <span style="font-size: 0.78rem; color: var(--text-secondary);"><strong style="color: var(--text-primary);">Dev:</strong> ${b.developer || 'Unassigned'}</span>
          </div>
          ${(currentUserRole !== 'developer') ? `
          <div class="bug-action-btns" onclick="event.stopPropagation();">
            <button class="bug-action-btn" onclick="openBugModal('${b.projectId}', '${b.id}')" title="Edit Bug Details">
              <span class="material-icons-round" style="font-size: 1.1rem;">edit</span>
            </button>
            <button class="bug-action-btn delete" onclick="deleteBug('${b.id}')" title="Delete Bug">
              <span class="material-icons-round" style="font-size: 1.1rem;">delete</span>
            </button>
          </div>` : ''}
          <span class="material-icons-round expand-arrow" style="color: var(--text-secondary); transition: transform 0.2s;">keyboard_arrow_down</span>
        </div>
        
        <div class="bug-details" id="bugDetails_${b.id}">
          <div class="bug-desc-header">Description / Steps to Reproduce</div>
          <div class="bug-description-content">${b.desc || 'No detailed steps or description provided.'}</div>
          
          ${screenshotHtml}

          <!-- Developer Comments Section -->
          <div class="bug-comments-section">
            <div class="bug-comments-title">
              <span class="material-icons-round" style="font-size: 1.1rem;">comment</span>
              Developer Comments (${(b.comments || []).length})
            </div>
            
            <div class="comments-list" id="commentsList_${b.id}">
              ${commentsListHtml || '<div style="font-size: 0.8rem; color: var(--text-secondary); padding: 6px 0;">No comments added yet.</div>'}
            </div>
            
            <form class="comment-form" onsubmit="addBugComment(event, '${b.id}')">
              <input type="text" class="comment-input-field" placeholder="Add a response or developer comment..." required id="commentInput_${b.id}">
              <button type="submit" class="btn btn-primary comment-submit-btn">
                <span class="material-icons-round" style="font-size: 1.1rem;">send</span>
              </button>
            </form>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Expand/Collapse Bug Card
function toggleBugDetails(bugId) {
  const card = document.getElementById(`bugCard_${bugId}`);
  const arrow = card.querySelector('.expand-arrow');
  if (card) {
    const isExpanded = card.classList.toggle('expanded');
    if (arrow) {
      arrow.style.transform = isExpanded ? 'rotate(180deg)' : 'rotate(0deg)';
    }
  }
}

// Inline Bug Status Switcher
function changeBugStatus(bugId, newStatus) {
  const bug = state.bugs.find(b => b.id === bugId);
  if (bug) {
    const oldStatus = bug.status;
    bug.status = newStatus;
    
    // Add developer comment log automatically
    bug.comments.unshift({
      author: 'System',
      text: `Status changed from "${oldStatus}" to "${newStatus}".`,
      time: new Date().toISOString().replace('T', ' ').substring(0, 16)
    });

    saveState();
    syncItemToCloud('bugs', bug);
    addNotification(`Bug "${bug.title}" status changed to ${newStatus}.`, 'info');
    showToast(`Bug status updated to ${newStatus}`);
    
    // Re-render project details to recalculate percentages
    renderProjectDetailsView(activeDetailProjectId);
  }
}

// Developer Comment Form Submit Handler
function addBugComment(e, bugId) {
  e.preventDefault();
  const input = document.getElementById(`commentInput_${bugId}`);
  if (!input) return;

  const commentText = input.value.trim();
  if (!commentText) return;

  const bug = state.bugs.find(b => b.id === bugId);
  if (bug) {
    if (!bug.comments) bug.comments = [];
    
    const newComment = {
      author: state.profile.name,
      text: commentText,
      time: new Date().toISOString().replace('T', ' ').substring(0, 16)
    };

    bug.comments.push(newComment);
    saveState();
    syncItemToCloud('bugs', bug);
    showToast('Comment added');
    
    input.value = '';
    
    // Refresh comments list UI only
    const commentsList = document.getElementById(`commentsList_${bugId}`);
    if (commentsList) {
      commentsList.innerHTML = bug.comments.map(c => `
        <div class="comment-item">
          <div class="comment-header">
            <span class="comment-author">${c.author}</span>
            <span class="comment-time">${c.time}</span>
          </div>
          <div class="comment-body">${c.text}</div>
        </div>
      `).join('');
    }

    // Add alert notification
    addNotification(`New developer comment on bug "${bug.title}".`, 'info');
  }
}

// ===== Bug Modal CRUD =====
function openBugModal(projectId, bugId = null) {
  const modal = document.getElementById('bugModal');
  const form = document.getElementById('bugForm');
  const title = document.getElementById('bugModalTitle');
  const pIdInput = document.getElementById('bugProjectId');
  const bugIdInput = document.getElementById('editBugId');
  const previewContainer = document.getElementById('bugScreenshotPreviewContainer');
  const previewImage = document.getElementById('bugScreenshotPreview');
  const statusLabel = document.getElementById('bugScreenshotStatus');

  if (!modal) return;

  // Populate developer dropdown dynamically from testers/team list
  const devSelect = document.getElementById('bugDeveloper');
  if (devSelect) {
    let optionsHtml = '<option value="Unassigned">Unassigned</option>';
    
    // Add all team members from state.testers (includes developers auto-registered)
    state.testers.forEach(t => {
      optionsHtml += `<option value="${t.name}">${t.name} (${t.role})</option>`;
    });
    
    devSelect.innerHTML = optionsHtml;
  }

  // Setup form values
  pIdInput.value = projectId;
  tempBugScreenshotBase64 = '';
  statusLabel.textContent = 'Click to upload image';
  previewContainer.style.display = 'none';
  previewImage.src = '';

  if (bugId) {
    title.textContent = 'Edit Bug Details';
    const bug = state.bugs.find(b => b.id === bugId);
    if (bug) {
      bugIdInput.value = bug.id;
      document.getElementById('bugTitle').value = bug.title;
      document.getElementById('bugType').value = bug.type;
      document.getElementById('bugSeverity').value = bug.severity;
      document.getElementById('bugStatus').value = bug.status;
      document.getElementById('bugDeveloper').value = bug.developer || 'Unassigned';
      document.getElementById('bugDesc').value = bug.desc || '';
      
      if (bug.screenshot) {
        tempBugScreenshotBase64 = bug.screenshot;
        previewImage.src = bug.screenshot;
        previewContainer.style.display = 'block';
        statusLabel.textContent = 'Screenshot attached';
      }
    }
  } else {
    title.textContent = 'Report New Bug';
    form.reset();
    bugIdInput.value = '';
    pIdInput.value = projectId;
    document.getElementById('bugSeverity').value = 'Medium';
    document.getElementById('bugStatus').value = 'Pending';
    document.getElementById('bugDeveloper').value = 'Unassigned';
  }

  modal.classList.add('show');
}

function closeBugModal() {
  const modal = document.getElementById('bugModal');
  if (modal) modal.classList.remove('show');
  tempBugScreenshotBase64 = '';
}

// Handle Screenshot Buttons
document.getElementById('bugScreenshotBtn').addEventListener('click', () => {
  document.getElementById('bugScreenshotFile').click();
});

document.getElementById('bugScreenshotFile').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) {
    showToast('Image file too large. Max 2MB.', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = function(event) {
    tempBugScreenshotBase64 = event.target.result;
    
    const previewContainer = document.getElementById('bugScreenshotPreviewContainer');
    const previewImage = document.getElementById('bugScreenshotPreview');
    const statusLabel = document.getElementById('bugScreenshotStatus');

    previewImage.src = tempBugScreenshotBase64;
    previewContainer.style.display = 'block';
    statusLabel.textContent = 'Image loaded';
  };
  reader.readAsDataURL(file);
});

document.getElementById('removeBugScreenshotBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  tempBugScreenshotBase64 = '';
  document.getElementById('bugScreenshotFile').value = '';
  document.getElementById('bugScreenshotPreviewContainer').style.display = 'none';
  document.getElementById('bugScreenshotPreview').src = '';
  document.getElementById('bugScreenshotStatus').textContent = 'Click to upload image';
});

// Bug Form Submit Handler
document.getElementById('bugForm').addEventListener('submit', function(e) {
  e.preventDefault();

  const projectId = document.getElementById('bugProjectId').value;
  const bugId = document.getElementById('editBugId').value;
  const title = document.getElementById('bugTitle').value.trim();
  const type = document.getElementById('bugType').value;
  const severity = document.getElementById('bugSeverity').value;
  const status = document.getElementById('bugStatus').value;
  const developer = document.getElementById('bugDeveloper').value;
  const desc = document.getElementById('bugDesc').value.trim();

  if (!title || !projectId) {
    showToast('Bug title is required', 'error');
    return;
  }

  let finalBug = null;

  if (bugId) {
    // Edit Mode
    const bugIndex = state.bugs.findIndex(b => b.id === bugId);
    if (bugIndex > -1) {
      finalBug = {
        ...state.bugs[bugIndex],
        title,
        type,
        severity,
        status,
        developer,
        desc,
        screenshot: tempBugScreenshotBase64
      };
      state.bugs[bugIndex] = finalBug;
      
      const countIndex = bugIndex + 1;
      addNotification(`Bug #${countIndex} "${title}" details updated.`, 'info');
      showToast('Bug updated successfully!');
    }
  } else {
    // Add Mode
    finalBug = {
      id: 'bug_' + Date.now(),
      projectId,
      title,
      type,
      severity,
      status,
      developer,
      desc,
      screenshot: tempBugScreenshotBase64,
      comments: [
        { author: 'System', text: 'Bug reported by Tester.', time: new Date().toISOString().replace('T', ' ').substring(0, 16) }
      ],
      created: new Date().toISOString().split('T')[0]
    };
    state.bugs.push(finalBug);
    addNotification(`New bug reported on project: "${title}"`, 'warning');
    showToast('Bug reported successfully!');
  }

  saveState();
  if (finalBug) syncItemToCloud('bugs', finalBug);
  closeBugModal();
  renderProjectDetailsView(activeDetailProjectId);
});

// Delete Bug Action
function deleteBug(bugId) {
  if (confirm('Are you sure you want to delete this bug?')) {
    const bug = state.bugs.find(b => b.id === bugId);
    if (bug) {
      state.bugs = state.bugs.filter(b => b.id !== bugId);
      addNotification(`Bug "${bug.title}" was deleted.`, 'warning');
      showToast('Bug deleted', 'info');
      saveState();
      deleteItemFromCloud('bugs', bugId);
      renderProjectDetailsView(activeDetailProjectId);
    }
  }
}

// ===== Lightbox Image Modal =====
function openLightbox(src) {
  const modal = document.getElementById('lightboxModal');
  const img = document.getElementById('lightboxImage');
  if (modal && img) {
    img.src = src;
    modal.classList.add('show');
  }
}

function closeLightbox() {
  const modal = document.getElementById('lightboxModal');
  if (modal) modal.classList.remove('show');
}

// ===== Calculation Helpers =====
function calculateProgressPercent() {
  const visible = getVisibleProjects();
  const total = visible.length;
  if (total === 0) return 0;
  const completed = visible.filter(p => p.status === 'Completed').length;
  return Math.round((completed / total) * 100);
}

// ===== Rendering Code =====

// Draw Progress Ring
function drawProgressRing(percent) {
  const canvas = document.getElementById('progressCanvas');
  const percentText = document.getElementById('progressPercent');
  if (!canvas || !percentText) return;

  percentText.textContent = `${percent}%`;

  const ctx = canvas.getContext('2d');
  const x = canvas.width / 2;
  const y = canvas.height / 2;
  const radius = 75;
  const startAngle = -0.5 * Math.PI;
  const endAngle = (percent / 100) * 2 * Math.PI + startAngle;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const isLight = document.body.classList.contains('light-theme');
  const trackColor = isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.06)';
  const accentColor = isLight ? '#4f46e5' : '#6366f1';
  const pinkColor = '#ec4899';

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.strokeStyle = trackColor;
  ctx.lineWidth = 14;
  ctx.stroke();

  if (percent > 0) {
    ctx.beginPath();
    ctx.arc(x, y, radius, startAngle, endAngle);
    
    const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    grad.addColorStop(0, accentColor);
    grad.addColorStop(1, pinkColor);
    
    ctx.strokeStyle = grad;
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

// Render Stats Cards
function renderStats() {
  const visible = getVisibleProjects();
  const total = visible.length;
  const pending = visible.filter(p => p.status === 'Pending').length;
  const inProgress = visible.filter(p => p.status === 'In Progress').length;
  const completed = visible.filter(p => p.status === 'Completed').length;

  document.getElementById('totalCount').textContent = total;
  document.getElementById('pendingCount').textContent = pending;
  document.getElementById('progressCount').textContent = inProgress;
  document.getElementById('completedCount').textContent = completed;
}

// Render Recent Projects on Dashboard
function renderRecentProjects() {
  const container = document.getElementById('recentProjectsList');
  if (!container) return;

  const searchQuery = document.getElementById('searchInput').value.toLowerCase().trim();

  let listProjects = getVisibleProjects().reverse();

  if (searchQuery) {
    listProjects = listProjects.filter(p => {
      const tester = state.testers.find(t => t.id === p.testerId);
      const testerName = tester ? tester.name.toLowerCase() : '';
      return p.name.toLowerCase().includes(searchQuery) ||
             (p.desc && p.desc.toLowerCase().includes(searchQuery)) ||
             testerName.includes(searchQuery);
    });
  }

  const recent = listProjects.slice(0, 4);

  if (recent.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--text-secondary); font-size: 0.9rem;">No matching projects</div>`;
    return;
  }

  container.innerHTML = recent.map(p => {
    const tester = state.testers.find(t => t.id === p.testerId);
    const testerName = tester ? tester.name : 'Unassigned';
    const initials = p.name.substring(0, 2).toUpperCase();

    let bgGrad = 'linear-gradient(135deg, var(--accent), var(--pink))';
    if (p.status === 'Completed') bgGrad = 'linear-gradient(135deg, #10b981, #059669)';
    if (p.status === 'In Progress') bgGrad = 'linear-gradient(135deg, #3b82f6, #1d4ed8)';
    if (p.status === 'Pending') bgGrad = 'linear-gradient(135deg, #f59e0b, #d97706)';

    let statusClass = 'pending';
    if (p.status === 'In Progress') statusClass = 'in-progress';
    if (p.status === 'Completed') statusClass = 'completed';

    // Count bugs (role-based filtering)
    let projectBugs = state.bugs.filter(b => b.projectId === p.id);
    if (currentUserRole === 'developer') {
      const devName = (_sessionName || '').trim().toLowerCase();
      projectBugs = projectBugs.filter(b => b.developer && b.developer.trim().toLowerCase() === devName);
    }
    const pendingBugs = projectBugs.filter(b => b.status === 'Pending' || b.status === 'Re-open').length;

    return `
      <div class="recent-project-item" style="cursor: pointer;" onclick="viewProjectDetails('${p.id}')">
        <div class="project-avatar" style="background: ${bgGrad}">${initials}</div>
        <div class="project-meta">
          <h4 style="display: flex; align-items: center; gap: 8px;">
            ${p.name}
            ${pendingBugs > 0 ? `<span style="background: var(--red); color: #fff; font-size: 0.68rem; font-weight: 700; padding: 1px 6px; border-radius: 10px;">${pendingBugs} bugs</span>` : ''}
          </h4>
          <span>Tester: ${testerName}</span>
        </div>
        <span class="status-badge ${statusClass}">${p.status}</span>
      </div>
    `;
  }).join('');
}

// Render Timeline Activity
function renderTimeline() {
  const container = document.getElementById('activityTimeline');
  if (!container) return;

  const recentNotifs = state.notifications.slice(0, 4);

  if (recentNotifs.length === 0) {
    container.innerHTML = `<div style="padding: 10px; text-align: center; color: var(--text-secondary);">No recent activity</div>`;
    return;
  }

  container.innerHTML = recentNotifs.map(n => {
    let dotColor = 'blue';
    if (n.type === 'success') dotColor = 'green';
    if (n.type === 'warning') dotColor = 'orange';
    if (n.type === 'error') dotColor = 'red';

    return `
      <div class="activity-item">
        <div class="activity-dot ${dotColor}"></div>
        <div class="activity-text">
          ${n.text}
        </div>
        <div class="activity-time">${n.time}</div>
      </div>
    `;
  }).join('');
}

// Render Projects Page Table
let activeFilter = 'all';

function getVisibleProjects() {
  if (currentUserRole === 'developer') {
    // Show all projects to developers so they can see what's active,
    // even if they don't have bugs assigned yet.
    return [...state.projects];
  }

  if (currentUserRole === 'tester') {
    const testerName = (_sessionName || '').trim().toLowerCase();

    // 1. Exact ID match: find tester record whose name exactly matches session name
    const matchedTester = state.testers.find(t => t.name.trim().toLowerCase() === testerName);
    if (matchedTester) {
      const projects = state.projects.filter(p => p.testerId === matchedTester.id);
      // If admin assigned projects to this tester, show them
      if (projects.length > 0) return projects;
    }

    // 2. Partial/flexible name match fallback (handles typos or abbreviated names)
    const partialMatch = state.testers.find(t => {
      const dbName = t.name.trim().toLowerCase();
      return dbName.includes(testerName) || testerName.includes(dbName);
    });
    if (partialMatch) {
      const projects = state.projects.filter(p => p.testerId === partialMatch.id);
      if (projects.length > 0) return projects;
    }

    // 3. Auto-register: tester not in testers list yet — show ALL projects so they
    //    are not locked out. Admin should formally add them via the Testers page.
    if (state.testers.length === 0 || !matchedTester) {
      console.warn('Tester not found in testers list. Showing all projects as fallback.');
      return [...state.projects];
    }

    return [];
  }

  // Admin/HR sees everything
  return [...state.projects];
}

function renderProjectsTable() {
  const tbody = document.getElementById('projectsTableBody');
  const table = document.querySelector('.projects-table');
  const emptyState = document.getElementById('emptyState');
  if (!tbody) return;

  const searchQuery = document.getElementById('searchInput').value.toLowerCase().trim();

  let filtered = getVisibleProjects();

  if (activeFilter !== 'all') {
    filtered = filtered.filter(p => p.status === activeFilter);
  }

  if (searchQuery) {
    filtered = filtered.filter(p => {
      const tester = state.testers.find(t => t.id === p.testerId);
      const testerName = tester ? tester.name.toLowerCase() : '';
      return p.name.toLowerCase().includes(searchQuery) ||
             (p.desc && p.desc.toLowerCase().includes(searchQuery)) ||
             testerName.includes(searchQuery);
    });
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    if (table) table.style.display = 'none';
    if (emptyState) emptyState.style.display = 'block';
    return;
  }

  if (table) table.style.display = 'table';
  if (emptyState) emptyState.style.display = 'none';

  // Type badge helper
  const typeBadge = (t) => {
    const map = { 'Web': '#3b82f6', 'App': '#f59e0b', 'Both': '#6366f1' };
    const label = t || 'Both';
    return `<span style="font-size:.7rem;font-weight:700;padding:2px 8px;border-radius:10px;background:${map[label] || '#6366f1'}22;color:${map[label] || '#6366f1'};border:1px solid ${map[label] || '#6366f1'}44;">${label === 'Both' ? 'Web & App' : label}</span>`;
  };

  tbody.innerHTML = filtered.map(p => {
    const tester = state.testers.find(t => t.id === p.testerId);
    const testerName = tester ? tester.name : 'Deleted Tester';
    
    let statusClass = 'pending';
    if (p.status === 'In Progress') statusClass = 'in-progress';
    if (p.status === 'Completed') statusClass = 'completed';

    let priorityClass = p.priority.toLowerCase();

    // Count bugs
    const projectBugs = state.bugs.filter(b => b.projectId === p.id);
    const totalCount = projectBugs.length;
    const activeBugsCount = projectBugs.filter(b => b.status === 'Pending' || b.status === 'In Progress' || b.status === 'Re-open').length;

    const actionsHtml = isHR ? `
      <div class="table-actions">
        <button class="edit-btn" onclick="openProjectModal('${p.id}')" title="Edit Project">
          <span class="material-icons-round" style="font-size: 1.15rem;">edit</span>
        </button>
        <button class="delete-btn" onclick="confirmDeleteProject('${p.id}')" title="Delete Project">
          <span class="material-icons-round" style="font-size: 1.15rem;">delete</span>
        </button>
      </div>` : `<span style="font-size:.75rem;color:var(--text-secondary);">—</span>`;

    return `
      <tr>
        <td>
          <div style="font-weight: 600; cursor: pointer; color: var(--accent); display: inline-block;" onclick="viewProjectDetails('${p.id}')" title="Click to view bugs">
            ${p.name}
          </div>
          <div style="font-size: 0.75rem; color: var(--text-secondary); max-width: 230px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${p.desc || ''}">
            ${p.desc || 'No description provided.'}
          </div>
        </td>
        <td>${testerName}</td>
        <td>${typeBadge(p.projectType)}</td>
        <td><span class="priority-badge ${priorityClass}">${p.priority}</span></td>
        <td><span class="status-badge ${statusClass}">${p.status}</span></td>
        <td>
          <div style="font-weight: 600; display: flex; align-items: center; gap: 4px; color: ${activeBugsCount > 0 ? 'var(--orange)' : 'var(--text-secondary)'}; cursor: pointer;" onclick="viewProjectDetails('${p.id}')">
            <span class="material-icons-round" style="font-size: 1rem;">bug_report</span>
            ${totalCount} (${activeBugsCount} Active)
          </div>
        </td>
        <td>${actionsHtml}</td>
      </tr>
    `;
  }).join('');
}

// Render Testers Page Grid
function renderTesters() {
  const grid = document.getElementById('testersGrid');
  if (!grid) return;

  const searchQuery = document.getElementById('searchInput').value.toLowerCase().trim();

  let listTesters = [...state.testers];

  if (searchQuery) {
    listTesters = listTesters.filter(t => 
      t.name.toLowerCase().includes(searchQuery) ||
      t.email.toLowerCase().includes(searchQuery) ||
      t.role.toLowerCase().includes(searchQuery)
    );
  }

  if (listTesters.length === 0) {
    grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-secondary);">No testers found.</div>`;
    return;
  }

  grid.innerHTML = listTesters.map(t => {
    const testerProjects = state.projects.filter(p => p.testerId === t.id);
    const activeCount = testerProjects.filter(p => p.status !== 'Completed').length;
    const completedCount = testerProjects.filter(p => p.status === 'Completed').length;
    
    const initials = t.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
    
    let hash = 0;
    for (let i = 0; i < t.name.length; i++) {
      hash = t.name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    const avatarBg = `hsl(${hue}, 65%, 45%)`;

    return `
      <div class="tester-card">
        <div class="tester-card-avatar" style="background: ${avatarBg}">${initials}</div>
        <h4>${t.name}</h4>
        <div class="tester-email">${t.email}</div>
        <span class="tester-role-badge">${t.role}</span>
        
        <div class="tester-stats">
          <div class="tester-stat">
            <span style="color: var(--blue);">${activeCount}</span>
            <span>Active</span>
          </div>
          <div class="tester-stat">
            <span style="color: var(--green);">${completedCount}</span>
            <span>Completed</span>
          </div>
        </div>
        <div class="tester-card-actions">
          <button class="btn btn-ghost btn-sm" onclick="deleteTester('${t.id}')" style="color: var(--red);">
            <span class="material-icons-round" style="font-size: 1rem; margin-right: 4px;">delete</span>
            Remove
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Render Reports Charts
function renderCharts() {
  const reportsPage = document.getElementById('reportsPage');
  if (!reportsPage || !reportsPage.classList.contains('active')) return;

  const ctxStatus = document.getElementById('statusChart');
  const ctxWorkload = document.getElementById('workloadChart');
  const ctxPriority = document.getElementById('priorityChart');
  
  if (!ctxStatus || !ctxWorkload || !ctxPriority) return;

  const isLight = document.body.classList.contains('light-theme');
  const textColor = isLight ? '#64748b' : '#9aa0b0';
  const gridColor = isLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.06)';

  if (statusChartInstance) statusChartInstance.destroy();
  if (workloadChartInstance) workloadChartInstance.destroy();
  if (priorityChartInstance) priorityChartInstance.destroy();

  // 1. Status Distribution
  const pending = state.projects.filter(p => p.status === 'Pending').length;
  const progress = state.projects.filter(p => p.status === 'In Progress').length;
  const completed = state.projects.filter(p => p.status === 'Completed').length;

  statusChartInstance = new Chart(ctxStatus, {
    type: 'doughnut',
    data: {
      labels: ['Pending', 'In Progress', 'Completed'],
      datasets: [{
        data: [pending, progress, completed],
        backgroundColor: ['#f59e0b', '#3b82f6', '#22c55e'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: textColor, font: { family: 'Inter', size: 11 } }
        }
      }
    }
  });

  // 2. Tester Workload
  const testerNames = state.testers.map(t => t.name);
  const testerWorkloads = state.testers.map(t => {
    return state.projects.filter(p => p.testerId === t.id && p.status !== 'Completed').length;
  });

  workloadChartInstance = new Chart(ctxWorkload, {
    type: 'bar',
    data: {
      labels: testerNames,
      datasets: [{
        label: 'Active Projects',
        data: testerWorkloads,
        backgroundColor: '#6366f1',
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          grid: { color: gridColor },
          ticks: { color: textColor, precision: 0 }
        },
        x: {
          grid: { display: false },
          ticks: { color: textColor }
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });

  // 3. Priority Breakdown
  const low = state.projects.filter(p => p.priority === 'Low').length;
  const medium = state.projects.filter(p => p.priority === 'Medium').length;
  const high = state.projects.filter(p => p.priority === 'High').length;
  const critical = state.projects.filter(p => p.priority === 'Critical').length;

  priorityChartInstance = new Chart(ctxPriority, {
    type: 'bar',
    data: {
      labels: ['Low', 'Medium', 'High', 'Critical'],
      datasets: [{
        label: 'Projects Count',
        data: [low, medium, high, critical],
        backgroundColor: ['#64748b', '#3b82f6', '#f59e0b', '#ef4444'],
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { color: textColor, precision: 0 }
        },
        y: {
          grid: { display: false },
          ticks: { color: textColor }
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

// Master Render Function
function renderAll() {
  renderStats();
  renderRecentProjects();
  renderTimeline();
  renderProjectsTable();
  renderTesters();
  renderProfile();
  renderNotifications();
  
  if (currentPage === 'projectDetails') {
    renderProjectDetailsView(activeDetailProjectId);
  }

  const progressPercent = calculateProgressPercent();
  drawProgressRing(progressPercent);
  renderCharts();
}

// ===== Event Listeners Wire-up =====

// Bind Open Modal Buttons
document.getElementById('addProjectBtn').addEventListener('click', () => openProjectModal());
document.getElementById('addProjectBtn2').addEventListener('click', () => openProjectModal());
document.getElementById('addTesterBtn').addEventListener('click', () => openTesterModal());
document.getElementById('addBugBtn').addEventListener('click', () => openBugModal(activeDetailProjectId));

// Bind Close Modal Buttons
document.getElementById('modalClose').addEventListener('click', closeProjectModal);
document.getElementById('modalCancel').addEventListener('click', closeProjectModal);
document.getElementById('testerModalClose').addEventListener('click', closeTesterModal);
document.getElementById('testerModalCancel').addEventListener('click', closeTesterModal);
document.getElementById('bugModalClose').addEventListener('click', closeBugModal);
document.getElementById('bugModalCancel').addEventListener('click', closeBugModal);

// Profile Modals Triggers
document.getElementById('topUserProfile').addEventListener('click', openProfileModal);
document.getElementById('sidebarUserProfile').addEventListener('click', openProfileModal);
document.getElementById('profileModalClose').addEventListener('click', closeProfileModal);
document.getElementById('profileModalCancel').addEventListener('click', closeProfileModal);

// Back to previous page from project details
document.getElementById('backToPreviousBtn').addEventListener('click', () => {
  switchPage(previousPage);
});

// Lightbox Modal Close
document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
document.getElementById('lightboxModal').addEventListener('click', (e) => {
  if (e.target.id === 'lightboxModal') closeLightbox();
});

// Navigation Sidebar Toggle
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('sidebarOverlay');

document.getElementById('menuToggle').addEventListener('click', () => {
  sidebar.classList.add('open');
  overlay.classList.add('show');
});

const closeSidebar = () => {
  sidebar.classList.remove('open');
  overlay.classList.remove('show');
};

document.getElementById('sidebarClose').addEventListener('click', closeSidebar);
overlay.addEventListener('click', closeSidebar);

// Navigation Items clicks
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const pageId = item.getAttribute('data-page');
    switchPage(pageId);
    closeSidebar();
  });
});

// View All Projects button on Dashboard
document.getElementById('viewAllProjectsBtn').addEventListener('click', () => {
  switchPage('projects');
});

// Theme Toggle
document.getElementById('themeToggle').addEventListener('click', toggleTheme);

// Notifications dropdown click toggle
const notifBtn = document.getElementById('notifBtn');
const notifPanel = document.getElementById('notifPanel');

notifBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  notifPanel.classList.toggle('show');
  
  if (notifPanel.classList.contains('show')) {
    state.notifications.forEach(n => n.read = true);
    saveState();
    // Sync read statuses to cloud database
    state.notifications.forEach(n => syncItemToCloud('notifications', n));
    renderNotifications();
  }
});

document.addEventListener('click', (e) => {
  if (notifPanel && !notifPanel.contains(e.target) && e.target !== notifBtn) {
    notifPanel.classList.remove('show');
  }
});

document.getElementById('clearNotifs').addEventListener('click', () => {
  // Delete all notifications
  if (supabaseClient) {
    state.notifications.forEach(n => deleteItemFromCloud('notifications', n.id));
  }
  state.notifications = [];
  saveState();
  renderNotifications();
  showToast('Notifications cleared', 'info');
});

// Search input keyup trigger
document.getElementById('searchInput').addEventListener('input', () => {
  if (currentPage === 'projectDetails') {
    renderProjectDetailsView(activeDetailProjectId);
  } else {
    renderRecentProjects();
    renderProjectsTable();
    renderTesters();
  }
});

// Table Filter Buttons
document.querySelectorAll('.filter-btn').forEach(btn => {
  if (btn.classList.contains('bug-filter-btn')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bug-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeBugFilter = btn.getAttribute('data-filter');
      renderProjectBugsList(activeDetailProjectId);
    });
  } else {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn:not(.bug-filter-btn)').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.getAttribute('data-filter');
      renderProjectsTable();
    });
  }
});

// Bug Type Select Filter
document.getElementById('bugTypeFilter').addEventListener('change', () => {
  renderProjectBugsList(activeDetailProjectId);
});

// Canvas Particles decoration background (animated float)
function initCanvasParticles() {
  const container = document.getElementById('bgParticles');
  if (!container) return;

  const count = 15;
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('div');
    dot.className = 'dot';
    
    const size = Math.random() * 8 + 4;
    const top = Math.random() * 100;
    const left = Math.random() * 100;
    const duration = Math.random() * 15 + 10;
    const delay = Math.random() * -20;

    dot.style.width = `${size}px`;
    dot.style.height = `${size}px`;
    dot.style.top = `${top}%`;
    dot.style.left = `${left}%`;
    dot.style.animationDuration = `${duration}s`;
    dot.style.animationDelay = `${delay}s`;

    container.appendChild(dot);
  }
}

// ===== Role-Based UI Control =====
function applyRoleUI() {
  const role = currentUserRole;
  const roleBadge = document.getElementById('roleBadge');

  // Update role badge text and color
  if (roleBadge) {
    if (role === 'hr') {
      roleBadge.textContent = 'Admin';
      roleBadge.style.background = 'rgba(99,102,241,.15)';
      roleBadge.style.color = 'var(--accent)';
      roleBadge.style.border = '1px solid rgba(99,102,241,.25)';
    } else if (role === 'developer') {
      roleBadge.textContent = 'Developer';
      roleBadge.style.background = 'rgba(236,72,153,.15)';
      roleBadge.style.color = 'var(--pink)';
      roleBadge.style.border = '1px solid rgba(236,72,153,.25)';
    } else {
      roleBadge.textContent = 'Tester';
      roleBadge.style.background = 'rgba(34,197,94,.12)';
      roleBadge.style.color = 'var(--green)';
      roleBadge.style.border = '1px solid rgba(34,197,94,.2)';
    }
  }

  // Show/hide HR-only nav items (testers, reports)
  document.querySelectorAll('.hr-only').forEach(el => {
    el.style.display = isHR ? '' : 'none';
  });

  // Show/hide HR-only buttons in dashboard and projects page
  document.querySelectorAll('.hr-action').forEach(el => {
    el.style.display = isHR ? '' : 'none';
  });

  // Disable profile edit click for non-admin
  const topUserProfile = document.getElementById('topUserProfile');
  const sidebarUserProfile = document.getElementById('sidebarUserProfile');
  if (!isHR) {
    if (topUserProfile) topUserProfile.style.cursor = 'default';
    if (sidebarUserProfile) sidebarUserProfile.style.pointerEvents = 'none';
  }

  // Hide Report Bug button for developer
  const addBugBtn = document.getElementById('addBugBtn');
  if (addBugBtn) {
    addBugBtn.style.display = (role === 'developer') ? 'none' : '';
  }

  // Auto-register developer in the testers/team list if not already there
  // Uses SESSION name so developer sees their own name, not the admin's
  if (role === 'developer' && _sessionName) {
    const devName = _sessionName.trim();
    const devSpecialty = sessionStorage.getItem('ayt_dev_specialty') || 'Web Developer';
    const exists = state.testers.some(t => t.name.trim().toLowerCase() === devName.toLowerCase());
    if (!exists) {
      const newDevTester = {
        id: 'dev_' + Date.now(),
        name: devName,
        email: 'developer@company.com',
        role: devSpecialty
      };
      state.testers.push(newDevTester);
      saveState();
      syncItemToCloud('testers', newDevTester);
    }
  }
}

// ===== Cloud Sync via MongoDB API (/api/db) =====
async function tryFetchCloudState() {
  try {
    const success = await fetchCloudData();
    if (success) {
      applyRoleUI();
      renderAll();
      showToast('✓ Synced with MongoDB — data is live!', 'success');
    } else {
      showToast('MongoDB not reachable. Running from local cache.', 'warning');
    }
  } catch (e) {
    console.warn('MongoDB fetch failed:', e);
    showToast('Running in offline mode.', 'warning');
  }
}

// ===== Page Initialization =====
window.addEventListener('DOMContentLoaded', () => {
  loadState();
  initTheme();
  applyRoleUI();
  
  // Render instantly from local cache so there is no blank screen
  renderAll();
  initCanvasParticles();

  // Load cloud data asynchronously in the background
  tryFetchCloudState();

  // ===== Auto-sync: poll MongoDB every 10s regardless of dbOnline state =====
  // Admin creates project on PC-A → Tester on PC-B sees it within 10 seconds.
  setInterval(async () => {
    const success = await fetchCloudData();
    if (success) { applyRoleUI(); renderAll(); }
  }, 10000); // 10 seconds for near real-time feel

  // ===== Logout =====
  document.getElementById('logoutBtn').addEventListener('click', () => {
    sessionStorage.clear();
    window.location.replace('login.html');
  });

  // Expose functions to window for onclick attributes in html string rendering
  window.openProjectModal = openProjectModal;
  window.confirmDeleteProject = confirmDeleteProject;
  window.deleteTester = deleteTester;
  window.viewProjectDetails = viewProjectDetails;
  window.toggleBugDetails = toggleBugDetails;
  window.changeBugStatus = changeBugStatus;
  window.addBugComment = addBugComment;
  window.openBugModal = openBugModal;
  window.deleteBug = deleteBug;
  window.openLightbox = openLightbox;

  // Expose manual refresh to window (for future use or manual trigger)
  window.manualRefreshFromCloud = async () => {
    showToast('Refreshing from database...', 'info');
    const success = await fetchCloudData();
    if (success) { applyRoleUI(); renderAll(); showToast('Data refreshed!', 'success'); }
    else { showToast('Could not reach MongoDB. Check server config.', 'error'); }
  };
});
