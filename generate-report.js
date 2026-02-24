require('dotenv').config({ path: require('path').join(__dirname, '..', 'Daily Engineer Report', '.env') });
const path = require('path');
const fs = require('fs');

// ─── Configuration ───────────────────────────────────────────────────────────

const API_TOKEN = process.env.CLICKUP_API_TOKEN;
const BASE_URL = 'https://api.clickup.com/api/v2';
const SPACE_NAME = 'Tenant | Scrawlr Labs';
const FOLDER_NAME = 'Lodgr';
const TIMEZONE = 'America/Los_Angeles';
const SNAPSHOT_PATH = path.join(__dirname, 'feature-dates.json');
const STATUS_SNAPSHOT_PATH = path.join(__dirname, 'status-timestamps.json');

const TEAM_MEMBERS = [
  'Annabelle Clink',
  'Donald Ma',
  'Alex Fex',
  'Brian Currie',
  'Sarah Dong',
  'Andrew Kim',
  'Saad Usmani',
];

// ─── Rate-limited API fetch ──────────────────────────────────────────────────

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 650;

async function fetchAPI(endpoint, params = {}) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    await sleep(MIN_REQUEST_INTERVAL - elapsed);
  }
  lastRequestTime = Date.now();

  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach(v => url.searchParams.append(key, v));
    } else {
      url.searchParams.set(key, value);
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url.toString(), {
      headers: { Authorization: API_TOKEN },
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
      console.log(`  Rate limited, waiting ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API error ${res.status} on ${endpoint}: ${body}`);
    }

    return res.json();
  }
  throw new Error(`Failed after 3 retries on ${endpoint}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── ClickUp Discovery ──────────────────────────────────────────────────────

async function discoverWorkspace() {
  console.log('Discovering ClickUp workspace...');

  const teamsData = await fetchAPI('/team');
  const teams = teamsData.teams;
  if (!teams || teams.length === 0) throw new Error('No workspaces found');
  const teamId = teams[0].id;
  console.log(`  Workspace: ${teams[0].name} (${teamId})`);

  const spacesData = await fetchAPI(`/team/${teamId}/space`, { archived: 'false' });
  const space = spacesData.spaces.find(s => s.name === SPACE_NAME);
  if (!space) throw new Error(`Space "${SPACE_NAME}" not found`);
  console.log(`  Space: ${space.name} (${space.id})`);

  const foldersData = await fetchAPI(`/space/${space.id}/folder`, { archived: 'false' });
  const folder = foldersData.folders.find(f => f.name === FOLDER_NAME);
  if (!folder) throw new Error(`Folder "${FOLDER_NAME}" not found`);
  console.log(`  Folder: ${folder.name} (${folder.id})`);

  return { folderId: folder.id };
}

// ─── Fetch Lists and Tasks ──────────────────────────────────────────────────

async function fetchAllLists(folderId) {
  const listsData = await fetchAPI(`/folder/${folderId}/list`, { archived: 'false' });
  return listsData.lists || [];
}

async function fetchListDetails(lists) {
  const detailedLists = [];
  for (const list of lists) {
    const details = await fetchAPI(`/list/${list.id}`);
    detailedLists.push(details);
  }
  const detailedListMap = new Map();
  for (const dl of detailedLists) detailedListMap.set(dl.id, dl);
  return { detailedLists, detailedListMap };
}

async function fetchTasksForList(listId) {
  const allTasks = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const data = await fetchAPI(`/list/${listId}/task`, {
      subtasks: 'true',
      include_closed: 'true',
      page: String(page),
    });
    const tasks = data.tasks || [];
    allTasks.push(...tasks);
    hasMore = tasks.length >= 100;
    page++;
  }

  return allTasks.filter(t => !t.archived);
}

async function fetchAllTasks(lists) {
  const allTasksByList = [];

  console.log('\nFetching tasks...');
  for (const list of lists) {
    const tasks = await fetchTasksForList(list.id);
    console.log(`  ${list.name}: ${tasks.length} tasks`);
    allTasksByList.push({ list, tasks });
  }

  return allTasksByList;
}

async function fetchTaskComments(taskId) {
  try {
    const data = await fetchAPI(`/task/${taskId}/comment`);
    return data.comments || [];
  } catch (e) {
    console.log(`  Warning: Could not fetch comments for task ${taskId}: ${e.message}`);
    return [];
  }
}


async function fetchBulkTimeInStatus(taskIds) {
  if (taskIds.length === 0) return {};
  const result = {};
  // Batch in groups of 25 to avoid URL length issues
  for (let i = 0; i < taskIds.length; i += 25) {
    const batch = taskIds.slice(i, i + 25);
    try {
      const data = await fetchAPI('/task/bulk_time_in_status/task_ids', {
        task_ids: batch,
      });
      Object.assign(result, data);
    } catch (e) {
      console.log(`  Warning: Time in Status not available (${e.message}). Skipping.`);
      return {};
    }
  }
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isV15List(list) {
  return (list.name || '').toLowerCase().startsWith('v1.5');
}

function formatDate(timestamp) {
  if (!timestamp) return 'TBD';
  const d = new Date(parseInt(timestamp));
  if (isNaN(d.getTime())) return 'TBD';
  return d.toLocaleDateString('en-US', { timeZone: TIMEZONE, month: 'short', day: 'numeric', year: 'numeric' });
}

function formatReportDate() {
  return new Date().toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function getWorkdayCutoff(defaultHours = 24) {
  const dayOfWeek = new Date().toLocaleDateString('en-US', { timeZone: TIMEZONE, weekday: 'long' });
  const hoursBack = dayOfWeek === 'Monday' ? 72 : defaultHours;
  return Date.now() - hoursBack * 60 * 60 * 1000;
}

function getActivityWindowLabel() {
  const dayOfWeek = new Date().toLocaleDateString('en-US', { timeZone: TIMEZONE, weekday: 'long' });
  return dayOfWeek === 'Monday' ? 'since Friday' : 'in the last 24 hours';
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripV15Prefix(name) {
  return name.replace(/^v1\.5\s*/i, '').trim();
}

function extractContentLine(content, label) {
  if (!content) return '';
  const regex = new RegExp(`^${label}:[ \\t]*(.+)$`, 'im');
  const match = content.match(regex);
  return match ? match[1].trim() : '';
}

function extractCommentText(commentArray) {
  if (!commentArray || !Array.isArray(commentArray)) return null;
  return commentArray
    .filter(part => part.text)
    .map(part => part.text)
    .join('')
    .trim() || null;
}

const BOILERPLATE_PATTERNS = [
  /^NOTE:\s*\n*\s*If you get blocked/i,
  /^Template:/i,
];

function getMostRecentMeaningfulComment(comments) {
  for (const comment of comments) {
    const text = comment.comment_text || extractCommentText(comment.comment);
    if (text && !BOILERPLATE_PATTERNS.some(p => p.test(text.trim()))) {
      return text.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

function matchedMembers(task) {
  const assigneeNames = (task.assignees || []).map(a => (a.username || `User ${a.id}`).toLowerCase());
  return TEAM_MEMBERS.filter(member => {
    const memberLower = member.toLowerCase();
    return assigneeNames.some(an => an === memberLower || an.includes(memberLower) || memberLower.includes(an));
  });
}

function isOverdue(dueDateStr, status) {
  if (!dueDateStr || dueDateStr === 'TBD') return false;
  const statusLower = (status || '').toLowerCase();
  if (statusLower === 'complete' || statusLower === 'closed' || statusLower === 'ready for deployment') return false;
  const due = new Date(dueDateStr);
  if (isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

function renderDueDate(dueDateStr, status) {
  if (isOverdue(dueDateStr, status)) {
    return `<span style="color:#b71c1c;font-weight:bold;">${escapeHtml(dueDateStr)}</span>`;
  }
  return escapeHtml(dueDateStr);
}

function renderDateWithChange(currentDate, history) {
  if (!history || history.length === 0) return escapeHtml(currentDate);
  const struck = history.map(d => `<span style="text-decoration:line-through;color:#999;">${escapeHtml(d)}</span>`).join(' ');
  return `${struck} <strong>${escapeHtml(currentDate)}</strong>`;
}

function renderDueDateWithChange(currentDate, history, status) {
  if (!history || history.length === 0) return renderDueDate(currentDate, status);
  const struck = history.map(d => `<span style="text-decoration:line-through;color:#999;">${escapeHtml(d)}</span>`).join(' ');
  const overdue = isOverdue(currentDate, status);
  const style = overdue ? ' style="color:#b71c1c;font-weight:bold;"' : '';
  return `${struck} <strong${style}>${escapeHtml(currentDate)}</strong>`;
}

function trackDateChanges(taskId, currentStartDate, currentDueDate, dateSnapshot) {
  const prev = dateSnapshot[taskId] || {};
  const prevStartDate = prev.startDate || null;
  const prevDueDate = prev.dueDate || null;
  const startHistory = prev.startDateHistory || [];
  const dueHistory = prev.dueDateHistory || [];

  const startChanged = prevStartDate && prevStartDate !== currentStartDate && prevStartDate !== 'TBD';
  const dueChanged = prevDueDate && prevDueDate !== currentDueDate && prevDueDate !== 'TBD';

  const newStartHistory = startChanged ? [...startHistory, prevStartDate] : startHistory;
  const newDueHistory = dueChanged ? [...dueHistory, prevDueDate] : dueHistory;

  dateSnapshot[taskId] = {
    startDate: currentStartDate,
    dueDate: currentDueDate,
    startDateHistory: newStartHistory,
    dueDateHistory: newDueHistory,
  };

  return {
    startDateHistory: newStartHistory,
    dueDateHistory: newDueHistory,
  };
}

// ─── Snapshot Tracking ───────────────────────────────────────────────────────

function loadDateSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveDateSnapshot(snapshot) {
  const tmp = SNAPSHOT_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tmp, SNAPSHOT_PATH);
}

function loadStatusSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_SNAPSHOT_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveStatusSnapshot(snapshot) {
  const tmp = STATUS_SNAPSHOT_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tmp, STATUS_SNAPSHOT_PATH);
}

// Shared map to store all detected status changes so they can be looked up by later functions
const allStatusChanges = new Map();

function detectStatusChange(task, statusSnapshot) {
  const now = new Date().toISOString();
  const currentStatus = task.status?.status || '';
  const prev = statusSnapshot[task.id];

  if (!prev) {
    // First time seeing this task — seed the snapshot
    statusSnapshot[task.id] = { status: currentStatus, since: now };
    return null;
  }

  if (prev.status === currentStatus) return null;

  const changeTime = task.date_updated
    ? new Date(parseInt(task.date_updated)).toLocaleString('en-US', {
        timeZone: TIMEZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
      })
    : null;

  // Update snapshot to current status, preserving the previous status for cross-run lookups
  statusSnapshot[task.id] = { status: currentStatus, since: now, previousStatus: prev.status };
  const change = { oldStatus: prev.status, newStatus: currentStatus, changeTime };
  allStatusChanges.set(task.id, change);
  return change;
}

// ─── Report Building (v2) ────────────────────────────────────────────────────

function getInitials(fullName) {
  return fullName.split(/\s+/).map(w => w[0].toUpperCase()).join('');
}

function memberInitials(task) {
  return matchedMembers(task).map(getInitials);
}

const EXCLUDED_LISTS = ['graveyard'];

async function buildCompletedTasks(allTasksByList, statusSnapshot, dateSnapshot) {
  const cutoff = getWorkdayCutoff();
  const completed = [];

  for (const { list, tasks } of allTasksByList) {
    if (EXCLUDED_LISTS.includes(list.name.toLowerCase())) continue;
    if (isV15List(list)) continue;
    for (const task of tasks) {
      const closedOrDone = task.date_closed || task.date_done;
      if (!closedOrDone) continue;
      const doneTime = parseInt(closedOrDone);
      if (isNaN(doneTime) || doneTime < cutoff) continue;

      const statusChange = detectStatusChange(task, statusSnapshot);
      const startDate = task.start_date ? formatDate(task.start_date) : 'TBD';
      const completedDate = formatDate(closedOrDone);
      const dateChanges = trackDateChanges(task.id, startDate, completedDate, dateSnapshot);
      const comments = await fetchTaskComments(task.id);
      const lastComment = getMostRecentMeaningfulComment(comments);
      const startDateHistory = dateChanges.startDateHistory;

      completed.push({
        id: task.id,
        name: task.name,
        url: task.url || null,
        priority: task.priority || null,
        initials: memberInitials(task),
        listName: list.name,
        startDate,
        completedDate,
        startDateHistory,
        statusChange,
        note: lastComment,
      });
    }
  }

  console.log(`  Completed in last 24h: ${completed.length}`);
  return completed;
}

async function buildBlockedTasks(allTasksByList, statusSnapshot, dateSnapshot) {
  const blocked = [];

  for (const { list, tasks } of allTasksByList) {
    if (EXCLUDED_LISTS.includes(list.name.toLowerCase())) continue;

    const taskMap = new Map();
    for (const t of tasks) taskMap.set(t.id, t);

    for (const task of tasks) {
      const status = (task.status?.status || '').toLowerCase();
      if (status !== 'blocked') continue;

      // Skip subtasks whose parent is not also blocked
      if (task.parent) {
        const parent = taskMap.get(task.parent);
        const parentStatus = (parent?.status?.status || '').toLowerCase();
        if (parentStatus !== 'blocked') continue;
      }

      const statusChange = detectStatusChange(task, statusSnapshot);
      const startDate = task.start_date ? formatDate(task.start_date) : 'TBD';
      const dueDate = task.due_date ? formatDate(task.due_date) : 'TBD';
      const dateChanges = trackDateChanges(task.id, startDate, dueDate, dateSnapshot);
      const comments = await fetchTaskComments(task.id);
      const lastComment = getMostRecentMeaningfulComment(comments);
      const startDateHistory = dateChanges.startDateHistory;
      const dueDateHistory = dateChanges.dueDateHistory;

      blocked.push({
        name: task.name,
        url: task.url || null,
        priority: task.priority || null,
        initials: memberInitials(task),
        listName: list.name,
        startDate,
        dueDate,
        startDateHistory,
        dueDateHistory,
        statusChange,
        note: lastComment,
      });
    }
  }

  console.log(`  Blocked tasks: ${blocked.length}`);
  return blocked;
}

const TASK_UPDATE_LISTS = ['Priority', 'QA/Usability', 'Fast-follow'];
const EXCLUDED_STATUSES = ['to do', 'paused', 'complete', 'closed'];

async function buildTaskUpdates(allTasksByList, statusSnapshot, dateSnapshot, completedTaskIds) {
  const updates = [];

  for (const listName of TASK_UPDATE_LISTS) {
    const entry = allTasksByList.find(({ list }) =>
      list.name.toLowerCase() === listName.toLowerCase()
    );
    if (!entry) continue;

    for (const task of entry.tasks) {
      if (task.parent) continue;
      const status = (task.status?.status || '').toLowerCase();
      if (EXCLUDED_STATUSES.includes(status)) continue;
      if (completedTaskIds.has(task.id)) continue;

      const statusChange = detectStatusChange(task, statusSnapshot);
      const startDate = task.start_date ? formatDate(task.start_date) : 'TBD';
      const dueDate = task.due_date ? formatDate(task.due_date) : 'TBD';
      const dateChanges = trackDateChanges(task.id, startDate, dueDate, dateSnapshot);
      const comments = await fetchTaskComments(task.id);
      const lastComment = getMostRecentMeaningfulComment(comments);
      const startDateHistory = dateChanges.startDateHistory;
      const dueDateHistory = dateChanges.dueDateHistory;

      updates.push({
        id: task.id,
        name: task.name,
        url: task.url || null,
        priority: task.priority || null,
        initials: memberInitials(task),
        status: task.status?.status || 'Unknown',
        listName: entry.list.name,
        startDate,
        dueDate,
        startDateHistory,
        dueDateHistory,
        statusChange,
        note: lastComment,
        timeInStatus: null,
      });
    }
  }

  console.log(`  Task updates: ${updates.length}`);
  return updates;
}

const RECENTLY_CREATED_LISTS = ['Priority', 'QA/Usability', 'Fast-follow'];

async function buildRecentlyCreatedTasks(allTasksByList) {
  const cutoff = getWorkdayCutoff();
  const created = [];

  for (const listName of RECENTLY_CREATED_LISTS) {
    const entry = allTasksByList.find(({ list }) =>
      list.name.toLowerCase() === listName.toLowerCase()
    );
    if (!entry) continue;

    for (const task of entry.tasks) {
      if (task.parent) continue;
      const createdTime = parseInt(task.date_created);
      if (isNaN(createdTime) || createdTime < cutoff) continue;

      const comments = await fetchTaskComments(task.id);
      const lastComment = getMostRecentMeaningfulComment(comments);

      created.push({
        name: task.name,
        url: task.url || null,
        priority: task.priority || null,
        initials: memberInitials(task),
        listName: entry.list.name,
        note: lastComment,
      });
    }
  }

  console.log(`  Recently created: ${created.length}`);
  return created;
}

function buildFeatureUpdates(allTasksByList, detailedListMap, dateSnapshot, statusSnapshot) {
  const features = [];

  for (const { list, tasks } of allTasksByList) {
    if (!isV15List(list)) continue;

    const detailed = detailedListMap.get(list.id);
    const content = detailed?.content || '';

    const status = extractContentLine(content, 'Status');
    const originalSizing = extractContentLine(content, 'Original Sizing') || extractContentLine(content, 'Initial Sizing');
    const sizingAfterPlanning = extractContentLine(content, 'Sizing After Technical Planning');
    const dailyReportNote = extractContentLine(content, 'Daily Report Note');

    // Collect unique assignee initials across all tasks in the list
    const allInitials = new Set();
    for (const task of tasks) {
      for (const init of memberInitials(task)) allInitials.add(init);
    }

    const startDate = detailed?.start_date ? formatDate(detailed.start_date) : 'TBD';
    const dueDate = detailed?.due_date ? formatDate(detailed.due_date) : 'TBD';
    const dateChanges = trackDateChanges(`feature_${list.id}`, startDate, dueDate, dateSnapshot);

    // Build milestone list for this feature (custom_item_id === 1)
    const milestones = [];
    const milestoneMap = new Map(); // milestone task id -> milestone object
    for (const task of tasks) {
      if (task.custom_item_id !== 1) continue;

      const statusChange = detectStatusChange(task, statusSnapshot);
      const taskStartDate = task.start_date ? formatDate(task.start_date) : 'TBD';
      const taskDueDate = task.due_date ? formatDate(task.due_date) : 'TBD';
      const taskDateChanges = trackDateChanges(task.id, taskStartDate, taskDueDate, dateSnapshot);

      const milestone = {
        id: task.id,
        name: task.name,
        url: task.url || null,
        priority: task.priority || null,
        initials: memberInitials(task),
        status: task.status?.status || 'Unknown',
        startDate: taskStartDate,
        dueDate: taskDueDate,
        startDateHistory: taskDateChanges.startDateHistory,
        dueDateHistory: taskDateChanges.dueDateHistory,
        statusChange,
        recentChanges: [],
      };
      milestones.push(milestone);
      milestoneMap.set(task.id, milestone);
    }

    // Collect non-milestone tasks with recent status changes, grouped by parent milestone
    const fortyEightHoursAgo = getWorkdayCutoff(48);
    const excludedStatuses = new Set(['to do', 'selected for development', 'in planning', 'paused', 'blocked', 'abandoned']);
    const otherChanges = [];
    for (const task of tasks) {
      if (task.custom_item_id === 1) continue;
      const currentStatus = (task.status?.status || '').toLowerCase();
      if (excludedStatuses.has(currentStatus)) continue;
      const updatedAt = parseInt(task.date_updated);
      if (!updatedAt || updatedAt < fortyEightHoursAgo) continue;

      // Look up from shared map first (change detected by an earlier builder this run),
      // then try detectStatusChange for tasks not yet processed,
      // then check snapshot for changes detected in a prior run (previousStatus + recent since)
      let statusChange = allStatusChanges.get(task.id) || detectStatusChange(task, statusSnapshot);
      if (!statusChange) {
        const snap = statusSnapshot[task.id];
        if (snap) {
          const sinceMs = new Date(snap.since).getTime();
          if (sinceMs >= fortyEightHoursAgo) {
            const changeTime = task.date_updated
              ? new Date(parseInt(task.date_updated)).toLocaleString('en-US', {
                  timeZone: TIMEZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
                })
              : null;
            if (snap.previousStatus && snap.previousStatus !== snap.status) {
              statusChange = { oldStatus: snap.previousStatus, newStatus: snap.status, changeTime };
            } else {
              // Task was recently seeded — show current status without old→new transition
              statusChange = { oldStatus: null, newStatus: snap.status, changeTime };
            }
          }
        }
      }
      if (!statusChange) continue;

      const entry = {
        name: task.name,
        url: task.url || null,
        statusChange,
      };

      const parentMilestone = task.parent ? milestoneMap.get(task.parent) : null;
      if (parentMilestone) {
        parentMilestone.recentChanges.push(entry);
      } else {
        otherChanges.push(entry);
      }
    }

    // Add an "Other" bucket if there are ungrouped changes
    if (otherChanges.length > 0) {
      milestones.push({
        id: null,
        name: 'Other',
        url: null,
        priority: null,
        initials: [],
        status: '',
        startDate: null,
        dueDate: null,
        previousStartDate: null,
        previousDueDate: null,
        statusChange: null,
        recentChanges: otherChanges,
      });
    }

    features.push({
      name: stripV15Prefix(list.name),
      initials: [...allInitials],
      status: status || 'TBD',
      originalSizing: originalSizing || 'TBD',
      sizingAfterPlanning: sizingAfterPlanning || 'TBD',
      dailyReportNote: dailyReportNote || '',
      startDate,
      dueDate,
      startDateHistory: dateChanges.startDateHistory,
      dueDateHistory: dateChanges.dueDateHistory,
      milestones,
    });
  }

  console.log(`  Feature updates: ${features.length}`);
  return features;
}

function statusColor(status) {
  if (!status) return '#888';
  const s = status.toLowerCase();
  if (s === 'to do') return '#888888';
  if (s === 'in planning') return '#d4a017';
  if (s === 'selected for development') return '#8B4513';
  if (s === 'paused') return '#5bc0de';
  if (s === 'abandoned') return '#e65100';
  if (s === 'blocked') return '#c62828';
  if (s === 'in progress') return '#1a3e7a';
  if (s === 'in review') return '#e91e8a';
  if (s === 'in qa') return '#7b1fa2';
  if (s === 'ready for deployment') return '#555555';
  if (s === 'complete' || s === 'closed') return '#2e7d32';
  return '#888';
}

function renderPriority() {
  return '';
}

function renderTaskName(name, url, priority) {
  let html = '';
  if (url) {
    html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(name)}</strong></a>`;
  } else {
    html += `<strong>${escapeHtml(name)}</strong>`;
  }
  html += renderPriority(priority);
  return html;
}

function renderStatus(status) {
  return `<span style="color:${statusColor(status)};">${escapeHtml(status)}</span>`;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return null;
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return '<1h';
}

const STALE_THRESHOLDS_DAYS = {
  'in review': 3,
  'in qa': 3,
  'blocked': 5,
  'in progress': 7,
};
const DEFAULT_STALE_DAYS = 5;

function renderStatusWithDuration(status, durationMs) {
  const dur = formatDuration(durationMs);
  if (!dur) return renderStatus(status);
  const statusLower = (status || '').toLowerCase();
  const threshold = STALE_THRESHOLDS_DAYS[statusLower] || DEFAULT_STALE_DAYS;
  const days = durationMs / (1000 * 60 * 60 * 24);
  const stale = days >= threshold;
  const durStyle = stale ? 'color:#e65100;font-weight:bold;' : 'color:#888;';
  return `${renderStatus(status)} <span style="font-size:11px;${durStyle}">(${dur})</span>`;
}

function renderStatusChange(statusChange) {
  if (!statusChange) return '';
  return `  <div style="font-size:11px;color:#555;padding:1px 8px;">Status Change: ${renderStatus(statusChange.oldStatus)} &rarr; ${renderStatus(statusChange.newStatus)}</div>\n`;
}

// ─── HTML Generation (v2) ────────────────────────────────────────────────────

function generateHTML(completedTasks, blockedTasks, taskUpdates, recentlyCreated, featureUpdates) {
  const reportDate = formatReportDate();

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Activity Report</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 40px;
      color: #333;
    }
    .header {
      margin-bottom: 0;
    }
    .header h1 {
      font-size: 18px;
      margin: 0;
    }
    .header .date {
      font-size: 14px;
      color: #555;
    }
    .section-title {
      font-size: 15px;
      font-weight: bold;
      margin: 20px 0 10px 0;
    }
    a {
      color: inherit;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    .note {
      font-size: 11px;
      color: #777;
      padding: 2px 8px 6px 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Daily Activity Report</h1>
    <span class="date">${reportDate}</span>
  </div>

  <div class="section-title">Completed Tasks</div>
`;

  if (completedTasks.length === 0) {
    html += `  <div style="font-size:13px;color:#888;">No tasks completed ${getActivityWindowLabel()}.</div>\n`;
  } else {
    for (const task of completedTasks) {
      const initials = task.initials.length > 0 ? ` (${task.initials.join(', ')})` : '';
      html += `  <div style="font-size:13px;padding:4px 0;">${renderTaskName(task.name, task.url, task.priority)}${escapeHtml(initials)} | Completed: ${escapeHtml(task.completedDate)}</div>\n`;
      if (task.note) {
        html += `  <div class="note">Notes: ${escapeHtml(truncate(task.note, 300))}</div>\n`;
      }
    }
  }

  html += `\n  <div class="section-title">Blocked Tasks</div>\n`;

  if (blockedTasks.length === 0) {
    html += `  <div style="font-size:13px;color:#888;">No blocked tasks.</div>\n`;
  } else {
    for (const task of blockedTasks) {
      const initials = task.initials.length > 0 ? ` (${task.initials.join(', ')})` : '';
      html += `  <div style="font-size:13px;padding:4px 0;">${renderTaskName(task.name, task.url, task.priority)}${escapeHtml(initials)} | ${escapeHtml(task.listName)} | Start: ${renderDateWithChange(task.startDate, task.startDateHistory)} | Due: ${renderDueDateWithChange(task.dueDate, task.dueDateHistory, 'blocked')}</div>\n`;
      html += renderStatusChange(task.statusChange);
      if (task.note) {
        html += `  <div class="note">Notes: ${escapeHtml(truncate(task.note, 300))}</div>\n`;
      }
    }
  }

  html += `\n  <div class="section-title">Task Updates</div>\n`;

  if (taskUpdates.length === 0) {
    html += `  <div style="font-size:13px;color:#888;">No task updates.</div>\n`;
  } else {
    for (const task of taskUpdates) {
      const initials = task.initials.length > 0 ? ` (${task.initials.join(', ')})` : '';
      const statusHtml = task.timeInStatus != null ? renderStatusWithDuration(task.status, task.timeInStatus) : renderStatus(task.status);
      html += `  <div style="font-size:13px;padding:4px 0;">${renderTaskName(task.name, task.url, task.priority)}${escapeHtml(initials)} | ${statusHtml} | ${escapeHtml(task.listName)} | Start: ${renderDateWithChange(task.startDate, task.startDateHistory)} | Due: ${renderDueDateWithChange(task.dueDate, task.dueDateHistory, task.status)}</div>\n`;
      html += renderStatusChange(task.statusChange);
      if (task.note) {
        html += `  <div class="note">Notes: ${escapeHtml(truncate(task.note, 300))}</div>\n`;
      }
    }
  }

  html += `\n  <div class="section-title">Recently Created Tasks</div>\n`;

  if (recentlyCreated.length === 0) {
    html += `  <div style="font-size:13px;color:#888;">No tasks created ${getActivityWindowLabel()}.</div>\n`;
  } else {
    for (const task of recentlyCreated) {
      const initials = task.initials.length > 0 ? ` (${task.initials.join(', ')})` : '';
      html += `  <div style="font-size:13px;padding:4px 0;">${renderTaskName(task.name, task.url, task.priority)}${escapeHtml(initials)} | ${escapeHtml(task.listName)}</div>\n`;
      if (task.note) {
        html += `  <div class="note">Notes: ${escapeHtml(truncate(task.note, 300))}</div>\n`;
      }
    }
  }

  html += `\n  <div class="section-title">Feature Updates</div>\n`;

  if (featureUpdates.length === 0) {
    html += `  <div style="font-size:13px;color:#888;">No feature updates.</div>\n`;
  } else {
    for (const feature of featureUpdates) {
      const initials = feature.initials.length > 0 ? ` (${feature.initials.join(', ')})` : '';
      const hasStart = feature.startDate && feature.startDate !== 'TBD';
      const hasDue = feature.dueDate && feature.dueDate !== 'TBD';
      let dateParts = '';
      if (hasStart || hasDue) {
        const segments = [];
        if (hasStart) segments.push(`Start: ${renderDateWithChange(feature.startDate, feature.startDateHistory)}`);
        if (hasDue) segments.push(`Due: ${renderDueDateWithChange(feature.dueDate, feature.dueDateHistory, feature.status)}`);
        dateParts = ' | ' + segments.join(' | ');
      }
      html += `  <div style="font-size:13px;padding:4px 0;"><strong>${escapeHtml(feature.name)}</strong>${escapeHtml(initials)}${dateParts}</div>\n`;
      html += `  <div style="font-size:11px;color:#555;padding:1px 8px;">Status: ${escapeHtml(feature.status)}</div>\n`;

      // Render milestones that have recent task status changes
      for (const milestone of feature.milestones) {
        if (milestone.recentChanges.length === 0) continue;
        html += `  <div style="font-size:12px;font-weight:bold;color:#444;padding:3px 16px 1px;">${escapeHtml(milestone.name)}</div>\n`;
        for (const change of milestone.recentChanges) {
          const taskName = change.url
            ? `<a href="${escapeHtml(change.url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(change.name)}</strong></a>`
            : `<strong>${escapeHtml(change.name)}</strong>`;
          const statusText = change.statusChange.oldStatus
            ? `${renderStatus(change.statusChange.oldStatus)} &rarr; ${renderStatus(change.statusChange.newStatus)}`
            : renderStatus(change.statusChange.newStatus);
          html += `  <div style="font-size:11px;color:#555;padding:1px 24px;">${taskName} | Status: ${statusText}</div>\n`;
        }
      }

      if (feature.dailyReportNote) {
        html += `  <div class="note">Notes: ${escapeHtml(feature.dailyReportNote)}</div>\n`;
      }
    }
  }

  html += `
</body>
</html>`;

  return html;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!API_TOKEN) {
    console.error('Error: CLICKUP_API_TOKEN not set. Check ../Daily Engineer Report/.env');
    process.exit(1);
  }

  console.log('=== Daily Activity Report ===\n');

  const { folderId } = await discoverWorkspace();

  console.log('\nFetching lists...');
  const lists = await fetchAllLists(folderId);

  console.log('Fetching list details...');
  const { detailedLists, detailedListMap } = await fetchListDetails(lists);

  const snapshot = loadDateSnapshot();
  const statusSnapshot = loadStatusSnapshot();

  const allTasksByList = await fetchAllTasks(lists);

  const completedTasks = await buildCompletedTasks(allTasksByList, statusSnapshot, snapshot);
  const completedTaskIds = new Set(completedTasks.map(t => t.id));
  const blockedTasks = await buildBlockedTasks(allTasksByList, statusSnapshot, snapshot);
  const taskUpdates = await buildTaskUpdates(allTasksByList, statusSnapshot, snapshot, completedTaskIds);

  // Fetch time-in-status for task updates
  const updateTaskIds = taskUpdates.map(t => t.id);
  console.log('\nFetching time in status...');
  const timeInStatusData = await fetchBulkTimeInStatus(updateTaskIds);
  for (const task of taskUpdates) {
    const entry = timeInStatusData[task.id];
    if (!entry || !entry.current_status) continue;
    const currentStatusTime = entry.current_status.total_time;
    if (currentStatusTime && currentStatusTime.by_minute > 0) {
      task.timeInStatus = currentStatusTime.by_minute * 60 * 1000;
    }
  }

  const recentlyCreated = await buildRecentlyCreatedTasks(allTasksByList);
  const featureUpdates = buildFeatureUpdates(allTasksByList, detailedListMap, snapshot, statusSnapshot);

  saveDateSnapshot(snapshot);
  saveStatusSnapshot(statusSnapshot);

  const html = generateHTML(completedTasks, blockedTasks, taskUpdates, recentlyCreated, featureUpdates);
  const outputPath = path.join(__dirname, 'daily-activity-report.html');
  fs.writeFileSync(outputPath, html);

  console.log(`\n✓ Report saved to: ${outputPath}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
