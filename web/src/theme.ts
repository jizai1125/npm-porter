import type { GlobalThemeOverrides } from 'naive-ui'

export const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#2563eb',
    primaryColorHover: '#3b82f6',
    primaryColorPressed: '#1d4ed8',
    primaryColorSuppl: '#3b82f6',
    borderRadius: '10px',
    fontSize: '14px'
  },
  Card: {
    borderRadius: '12px',
    paddingMedium: '22px',
    boxShadow: '0 10px 28px rgba(15, 23, 42, 0.06)'
  },
  Layout: {
    color: '#f6f8fb',
    headerColor: '#ffffff',
    siderColor: '#ffffff',
    headerBorderColor: '#eef2f7',
    siderBorderColor: '#eef2f7'
  },
  Button: {
    borderRadiusMedium: '8px'
  },
  DataTable: {
    borderRadius: '10px',
    thColor: '#f8fafc',
    tdColorHover: '#f5f9ff'
  }
}
