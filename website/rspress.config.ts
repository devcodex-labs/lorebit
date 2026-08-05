import { defineConfig } from '@rspress/core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const chineseSidebar = [
  {
    text: '开始之前',
    items: [
      { text: 'lorebit 是什么', link: '/' },
      { text: '第一次采用计划', link: '/start/first-plan' }
    ]
  },
  {
    text: '核心概念',
    items: [
      { text: 'RAG 工作流', link: '/concepts/rag-pipeline' },
      { text: '知识生命周期', link: '/concepts/knowledge-lifecycle' }
    ]
  },
  {
    text: '适配与边界',
    items: [
      { text: '数据库与索引适配器', link: '/adapters/database-adapters' },
      { text: '预览状态与公开契约', link: '/reference/preview-status' }
    ]
  },
  {
    text: '下一步',
    items: [{ text: '路线图', link: '/roadmap' }]
  }
];

const englishSidebar = [
  {
    text: 'Start here',
    items: [
      { text: 'What is lorebit?', link: '/en/' },
      { text: 'Your first adoption plan', link: '/en/start/first-plan' }
    ]
  },
  {
    text: 'Core concepts',
    items: [
      { text: 'RAG workflow', link: '/en/concepts/rag-pipeline' },
      { text: 'Knowledge lifecycle', link: '/en/concepts/knowledge-lifecycle' }
    ]
  },
  {
    text: 'Adapters and boundaries',
    items: [
      { text: 'Database and index adapters', link: '/en/adapters/database-adapters' },
      { text: 'Preview status and public contract', link: '/en/reference/preview-status' }
    ]
  },
  {
    text: 'Next',
    items: [{ text: 'Roadmap', link: '/en/roadmap' }]
  }
];

const chineseNav = [
  { text: '开始', link: '/' },
  { text: '概念', link: '/concepts/rag-pipeline' },
  { text: '适配器', link: '/adapters/database-adapters' },
  { text: '路线图', link: '/roadmap' }
];

const englishNav = [
  { text: 'Start', link: '/en/' },
  { text: 'Concepts', link: '/en/concepts/rag-pipeline' },
  { text: 'Adapters', link: '/en/adapters/database-adapters' },
  { text: 'Roadmap', link: '/en/roadmap' }
];

export default defineConfig({
  root: path.join(currentDir, '..', 'docs'),
  base: '/lorebit/',
  siteOrigin: 'https://devcodex-labs.github.io',
  lang: 'zh',
  title: 'lorebit',
  logoText: 'lorebit',
  description: '通用、RAG-first、provider-neutral 的知识基础设施。',
  outDir: 'dist',
  globalStyles: path.join(currentDir, 'styles', 'lorebit.css'),
  locales: [
    {
      lang: 'zh',
      label: '简体中文',
      title: 'lorebit',
      description: '通用、RAG-first、provider-neutral 的知识基础设施。'
    },
    {
      lang: 'en',
      label: 'English',
      title: 'lorebit',
      description: 'General-purpose, RAG-first, provider-neutral knowledge infrastructure.'
    }
  ],
  markdown: {
    link: {
      checkDeadLinks: true
    }
  },
  search: {
    codeBlocks: true
  },
  languageParity: {
    enabled: true
  },
  themeConfig: {
    localeRedirect: 'never',
    nav: chineseNav,
    sidebar: {
      '/': chineseSidebar,
      '/en/': englishSidebar
    },
    locales: [
      {
        lang: 'zh',
        label: '简体中文',
        nav: chineseNav,
        sidebar: { '/': chineseSidebar },
        footer: { message: 'Early Preview · Apache-2.0' }
      },
      {
        lang: 'en',
        label: 'English',
        nav: englishNav,
        sidebar: { '/en/': englishSidebar },
        footer: { message: 'Early Preview · Apache-2.0' }
      }
    ],
    socialLinks: [
      {
        icon: 'github',
        mode: 'link',
        content: 'https://github.com/devcodex-labs/lorebit'
      }
    ],
    footer: {
      message: 'Early Preview · Apache-2.0'
    }
  }
});
