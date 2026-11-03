/**
 * 业务常量：分类 / 情绪 / 记录类型
 * 颜色直接对应 WXSS 变量，保证 UI 与数据同源
 */

// 三分类 + 其他（不改 PRD 的四项，体重作为独立记录类型不占分类）
const CATEGORIES = [
  { key: 'sport', name: '运动', color: '#7CC5FF', wash: '#E6F4FF', emoji: '🏃' },
  { key: 'diet', name: '饮食', color: '#4FD8A4', wash: '#E2F9F0', emoji: '🥗' },
  { key: 'mood', name: '心情', color: '#FFC857', wash: '#FFF6DE', emoji: '💭' },
  { key: 'other', name: '其他', color: '#B9A7FF', wash: '#F0EBFF', emoji: '✨' }
];

// 情绪六档（顺序即选择器顺序）
const MOODS = [
  { key: 'joy', name: '开心', color: '#FFC857', wash: '#FFF6DE', emoji: '😄' },
  { key: 'calm', name: '平静', color: '#7CC5FF', wash: '#E6F4FF', emoji: '🙂' },
  { key: 'low', name: '低落', color: '#8E8B96', wash: '#F2EBDF', emoji: '😔' },
  { key: 'angry', name: '烦躁', color: '#FF6B4A', wash: '#FFEDE8', emoji: '😠' },
  { key: 'anx', name: '焦虑', color: '#B9A7FF', wash: '#F0EBFF', emoji: '😰' },
  { key: 'tired', name: '疲惫', color: '#A9C0B4', wash: '#E7F0EA', emoji: '😴' }
];

// 记录类型
const RECORD_TYPES = {
  text: { name: '文字', emoji: '✍️' },
  voice: { name: '语音', emoji: '🎙️' },
  image: { name: '图片', emoji: '📷' },
  weight: { name: '体重', emoji: '⚖️' }
};

// 底部 tabBar（与 app.json 顺序一致，custom-tab-bar 复用）
const TABS = [
  { path: '/pages/home/home', text: '今天' },
  { path: '/pages/timeline/timeline', text: '时间线' },
  { path: '/pages/record/record', text: '记录', center: true },
  { path: '/pages/stats/stats', text: '数据' },
  { path: '/pages/profile/profile', text: '我的' }
];

function findCategory(key) {
  return CATEGORIES.find(c => c.key === key) || CATEGORIES[3];
}
function findMood(key) {
  return MOODS.find(m => m.key === key) || null;
}

module.exports = { CATEGORIES, MOODS, RECORD_TYPES, TABS, findCategory, findMood };
