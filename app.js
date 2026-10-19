/**
 * WaterFlow - Web App Script
 * ระบบจัดการร้านน้ำ & บันทึกยอดขายรายวัน หักต้นทุน คำนวณกำไรสุทธิ
 */

// Global Storage Key
const STORAGE_KEY = 'waterflow_shop_data_v5';

// Supabase Cloud Sync Configuration
const SUPABASE_CONFIG = {
  url: 'https://nsltcgiovpirdkuvemmu.supabase.co',
  anonKey: 'sb_publishable_zwun7CNF6cyaNdF6VzZapQ_L6PRBdOi',
  storeId: 'shop_water_yay_tap'
};

// Initialize Supabase Client (if library loaded)
let supabaseClient = null;
if (typeof supabase !== 'undefined' && supabase.createClient) {
  try {
    supabaseClient = supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
  } catch (err) {
    console.warn('Supabase initialization failed:', err);
  }
}

// วันหยุดนักขัตฤกษ์ประจำปี 2026 (หรือวันหยุดโรงเรียน) ตัวอย่าง
const THAI_PUBLIC_HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-02', // วันขึ้นปีใหม่
  '2026-03-03', // วันมาฆบูชา
  '2026-04-06', '2026-04-13', '2026-04-14', '2026-04-15', // สงกรานต์
  '2026-05-01', '2026-05-04', '2026-05-31',
  '2026-06-03',
  '2026-07-28', '2026-07-29',
  '2026-08-12', // วันแม่แห่งชาติ
  '2026-10-13', // วันนวมินทรมหาราช
  '2026-10-23', // วันปิยมหาราช
  '2026-12-05', '2026-12-10', '2026-12-31'
];

// Initial Clean Data (เริ่มต้นค่าว่าง พร้อมใช้งาน)
const DEFAULT_DATA = {
  shopSettings: {
    name: 'ร้านน้ำยายแต๊ป',
    monthlyRent: 10000,
    schoolOpenDays: 20, // วันเปิดเรียนเฉลี่ยต่อเดือน
    vacationMonths: [] // เดือนปิดเทอมเริ่มต้น (เม.ย. และ ต.ค.)
  },
  dailySales: [],
  expenses: [],
  recipes: [],
  stockItems: [],
  savedProducts: [],
  customHolidays: []
};

class WaterFlowApp {
  constructor() {
    this.data = this.loadData();
    this.currentCalendarDate = new Date();
    this.selectedCalendarDayStr = this.formatDate(new Date());
    this.holidayPickerMonthDate = new Date();
    this.selectedBatchHolidayDates = new Set();
    this.charts = {
      trend: null,
      breakdown: null
    };

    this.initElements();
    this.bindEvents();
    this.initViews();

    // Start Supabase Cloud Sync
    this.initCloudSync();
  }

  // Load from LocalStorage or seed
  loadData() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      this.saveData(DEFAULT_DATA, false);
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.dailySales) {
        this.saveData(DEFAULT_DATA, false);
        return JSON.parse(JSON.stringify(DEFAULT_DATA));
      }
      if (!parsed.shopSettings) {
        parsed.shopSettings = JSON.parse(JSON.stringify(DEFAULT_DATA.shopSettings));
      }
      if (!Array.isArray(parsed.shopSettings.vacationMonths)) {
        parsed.shopSettings.vacationMonths = [];
      }
      if (!Array.isArray(parsed.savedProducts)) {
        parsed.savedProducts = [];
      }
      if (!Array.isArray(parsed.customHolidays)) {
        parsed.customHolidays = [];
      }
      if (!Array.isArray(parsed.stockItems)) {
        parsed.stockItems = [];
      }
      return parsed;
    } catch (e) {
      console.error('Error parsing stored data, resetting:', e);
      this.saveData(DEFAULT_DATA, false);
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
  }

  saveData(customData = null, syncToCloud = true) {
    const d = customData || this.data;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(d));

    if (syncToCloud) {
      this.pushDataToCloud(d);
    }
  }

  // =========================================================================
  // SUPABASE REALTIME CLOUD SYNC
  // =========================================================================
  async initCloudSync() {
    this.updateCloudSyncUI('syncing', 'กำลังเชื่อมต่อคลาวด์...');

    if (!supabaseClient) {
      this.updateCloudSyncUI('offline', 'ออฟไลน์ (Local)');
      return;
    }

    try {
      // 1. Pull latest data from Supabase
      await this.pullDataFromCloud();

      // 2. Subscribe to Realtime Changes from other devices
      supabaseClient
        .channel('app_store_changes')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'app_store', filter: `id=eq.${SUPABASE_CONFIG.storeId}` },
          (payload) => {
            if (payload && payload.new && payload.new.data) {
              const remoteData = payload.new.data;
              const localJson = JSON.stringify(this.data);
              const remoteJson = JSON.stringify(remoteData);
              if (localJson !== remoteJson) {
                this.data = remoteData;
                this.saveData(remoteData, false); // save to localStorage without re-pushing
                this.renderAllViews();
                this.showToast('ข้อมูลอัปเดตตรงกับเครื่องอื่นแล้ว ☁️', 'success');
              }
              this.updateCloudSyncUI('online', 'ซิงค์ตรงกันแล้ว');
            }
          }
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            this.updateCloudSyncUI('online', 'ออนไลน์ (เรียลไทม์)');
          }
        });
    } catch (err) {
      console.warn('Cloud sync error:', err);
      this.updateCloudSyncUI('offline', 'ออฟไลน์ (มีสำรองในเครื่อง)');
    }
  }

  async pullDataFromCloud() {
    if (!supabaseClient) return;
    try {
      const { data, error } = await supabaseClient
        .from('app_store')
        .select('data, updated_at')
        .eq('id', SUPABASE_CONFIG.storeId)
        .maybeSingle();

      if (error) {
        console.warn('Supabase pull error:', error);
        this.updateCloudSyncUI('offline', 'ออฟไลน์');
        return;
      }

      if (data && data.data) {
        // If remote data exists, sync it
        this.data = data.data;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
        this.renderAllViews();
        this.updateCloudSyncUI('online', 'เชื่อมต่อคลาวด์แล้ว');
      } else {
        // If first time and no record in Supabase yet, push current local data to seed Supabase
        await this.pushDataToCloud(this.data);
      }
    } catch (e) {
      console.warn('pullDataFromCloud exception:', e);
      this.updateCloudSyncUI('offline', 'ออฟไลน์');
    }
  }

  async pushDataToCloud(dataToPush) {
    if (!supabaseClient) return;
    this.updateCloudSyncUI('syncing', 'กำลังซิงค์...');

    try {
      const payload = {
        id: SUPABASE_CONFIG.storeId,
        data: dataToPush,
        updated_at: new Date().toISOString()
      };

      const { error } = await supabaseClient
        .from('app_store')
        .upsert(payload, { onConflict: 'id' });

      if (error) {
        console.warn('Supabase push error:', error);
        this.updateCloudSyncUI('offline', 'ซิงค์ไม่สำเร็จ (เซฟในเครื่องแล้ว)');
      } else {
        this.updateCloudSyncUI('online', 'ซิงค์ทุกเครื่องแล้ว');
      }
    } catch (e) {
      console.warn('pushDataToCloud exception:', e);
      this.updateCloudSyncUI('offline', 'ออฟไลน์ (เซฟในเครื่องแล้ว)');
    }
  }

  updateCloudSyncUI(status, label) {
    const badges = [
      document.getElementById('cloudSyncStatusMobile'),
      document.getElementById('cloudSyncStatusDesktop')
    ];

    badges.forEach(badge => {
      if (!badge) return;
      badge.classList.remove('syncing', 'offline');
      if (status === 'syncing') badge.classList.add('syncing');
      if (status === 'offline') badge.classList.add('offline');

      const textElem = badge.querySelector('.sync-text');
      if (textElem) {
        textElem.textContent = badge.classList.contains('desktop') ? `คลาวด์: ${label}` : (status === 'online' ? 'ซิงค์' : (status === 'syncing' ? 'กำลังส่ง' : 'ออฟไลน์'));
      }
      badge.setAttribute('title', `Supabase Cloud Sync: ${label}`);
    });
  }

  renderAllViews() {
    this.renderDashboard();
    this.renderTodaySummary();
    this.renderExpenses();
    this.renderSavedProducts();
    this.renderCalendar();
    this.renderRecipes();
    this.renderStock();
    this.refreshLucide();
  }

  formatDate(dateObj) {
    const d = new Date(dateObj);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  formatThaiDate(dateStr, includeYear = true) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const year = parseInt(parts[0], 10) + 543;
    const monthIndex = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    const thaiMonths = [
      'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
      'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
    ];
    return `${day} ${thaiMonths[monthIndex]} ${includeYear ? year : ''}`.trim();
  }

  isWeekend(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const day = d.getDay();
    return day === 0 || day === 6; // 0 = Sunday, 6 = Saturday
  }

  isPublicHoliday(dateStr) {
    return THAI_PUBLIC_HOLIDAYS_2026.includes(dateStr);
  }

  getCustomHoliday(dateStr) {
    return (this.data.customHolidays || []).find(h => h.date === dateStr);
  }

  isCustomHoliday(dateStr) {
    return !!this.getCustomHoliday(dateStr);
  }

  isHoliday(dateStr) {
    return this.isPublicHoliday(dateStr) || this.isCustomHoliday(dateStr);
  }

  getHolidayDescription(dateStr) {
    const custom = this.getCustomHoliday(dateStr);
    if (custom) return custom.reason || 'วันหยุดพิเศษ (กำหนดเอง)';
    if (this.isPublicHoliday(dateStr)) return 'วันหยุดนักขัตฤกษ์ / วันหยุดราชการ';
    return '';
  }

  isSchoolOpenDay(dateStr) {
    return !this.isWeekend(dateStr) && !this.isHoliday(dateStr);
  }

  getSchoolOpenDaysCount(ym = null) {
    if (!ym) {
      ym = this.formatDate(new Date()).substring(0, 7);
    }
    const [yearStr, monthStr] = ym.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10); // 1-indexed

    const daysInMonth = new Date(year, month, 0).getDate();
    let openDays = 0;

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (this.isSchoolOpenDay(dateStr)) {
        openDays++;
      }
    }
    return openDays > 0 ? openDays : 20;
  }

  isVacationMonth(ymOrMonth) {
    if (!this.data.shopSettings) return false;
    const vMonths = this.data.shopSettings.vacationMonths || [];
    let m = 0;
    if (typeof ymOrMonth === 'number') {
      m = ymOrMonth;
    } else if (typeof ymOrMonth === 'string') {
      if (ymOrMonth.includes('-')) {
        m = parseInt(ymOrMonth.split('-')[1], 10);
      } else {
        m = parseInt(ymOrMonth, 10);
      }
    }
    return vMonths.map(Number).includes(m);
  }

  getRentForMonth(ym) {
    if (this.isVacationMonth(ym)) {
      return 0; // เดือนปิดเทอม = ไม่คิดค่าเช่า (฿0)
    }
    return (this.data.shopSettings && Number(this.data.shopSettings.monthlyRent)) || 10000;
  }

  getDailyRentForSchoolDay(dateStr = null) {
    const ym = dateStr ? dateStr.substring(0, 7) : this.formatDate(new Date()).substring(0, 7);
    if (this.isVacationMonth(ym)) {
      return 0; // เดือนปิดเทอม = ค่าเช่ารายวันเป็น 0
    }
    const rent = this.getRentForMonth(ym);
    const days = this.getSchoolOpenDaysCount(ym);
    return Math.round(rent / (days > 0 ? days : 20));
  }

  formatThaiMonthYear(year, monthIndex) {
    const thaiMonthsFull = [
      'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
      'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
    ];
    return `${thaiMonthsFull[monthIndex]} ${year + 543}`;
  }

  formatCurrency(num) {
    const n = Number(num) || 0;
    return '฿' + n.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  updateShopBranding() {
    const shopName = (this.data.shopSettings && this.data.shopSettings.name) ? this.data.shopSettings.name : 'ร้านน้ำยายแต๊ป';

    // อัปเดต Title ของเบราว์เซอร์
    document.title = shopName;

    // อัปเดตชื่อใน Sidebar
    document.querySelectorAll('.brand-title').forEach(el => {
      el.textContent = shopName;
    });

    // อัปเดตชื่อใน Mobile Top Header
    document.querySelectorAll('.mobile-brand .brand-name').forEach(el => {
      el.textContent = shopName;
    });
  }

  initElements() {
    this.updateShopBranding();
    const now = new Date();
    const todayStr = this.formatDate(now);

    const currentDateDisplay = document.getElementById('currentDateDisplay');
    if (currentDateDisplay) {
      currentDateDisplay.innerHTML = `<i data-lucide="calendar"></i><span>วันนี้: ${this.formatThaiDate(todayStr)}</span>`;
    }

    // Set default month in dashboard selector
    const dashMonthSelect = document.getElementById('dashboardMonthSelect');
    if (dashMonthSelect) {
      dashMonthSelect.value = todayStr.substring(0, 7);
    }

    const rangeStart = document.getElementById('dashRangeStartMonth');
    const rangeEnd = document.getElementById('dashRangeEndMonth');
    if (rangeStart && rangeEnd) {
      // Default range: 3 months ago until this month
      const dStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      rangeStart.value = this.formatDate(dStart).substring(0, 7);
      rangeEnd.value = todayStr.substring(0, 7);
    }

    // Set today date input on Tab 2
    const todayInput = document.getElementById('selectedTodayDateInput');
    if (todayInput) {
      todayInput.value = todayStr;
    }

    // Set daily form date
    const dailyFormDate = document.getElementById('dailyFormDate');
    if (dailyFormDate) {
      dailyFormDate.value = todayStr;
    }

    // Set shop settings inputs
    const shopNameInput = document.getElementById('settingShopName');
    const rentInput = document.getElementById('settingMonthlyRent');
    if (shopNameInput && this.data.shopSettings) {
      shopNameInput.value = this.data.shopSettings.name || 'ร้านน้ำยายแต๊ป';
    }
    if (rentInput && this.data.shopSettings) {
      rentInput.value = this.data.shopSettings.monthlyRent || 10000;
    }

    // Initialize vacation months checkboxes
    this.updateVacationMonthsUI();
  }

  updateVacationMonthsUI() {
    const vMonths = (this.data.shopSettings && this.data.shopSettings.vacationMonths) || [];
    document.querySelectorAll('input[name="vacationMonth"]').forEach(cb => {
      const val = parseInt(cb.value, 10);
      cb.checked = vMonths.includes(val);
      const chip = cb.closest('.vacation-month-chip');
      if (chip) {
        if (cb.checked) {
          chip.style.borderColor = 'var(--primary)';
          chip.style.backgroundColor = '#eff6ff';
          chip.style.color = 'var(--primary)';
          chip.style.fontWeight = '700';
        } else {
          chip.style.borderColor = '#cbd5e1';
          chip.style.backgroundColor = '#ffffff';
          chip.style.color = 'inherit';
          chip.style.fontWeight = 'normal';
        }
      }
    });

    this.updateVacationChipsStyle();

    const countBadge = document.getElementById('vacationMonthsCountBadge');
    if (countBadge) {
      countBadge.textContent = vMonths.length > 0 ? `ปิดเทอม ${vMonths.length} เดือน (ค่าเช่า ฿0)` : 'ไม่มีเดือนปิดเทอม';
      countBadge.className = vMonths.length > 0 ? 'pill-tag purple-tag' : 'pill-tag';
    }
  }

  updateVacationChipsStyle() {
    document.querySelectorAll('input[name="vacationMonth"]').forEach(cb => {
      const chip = cb.closest('.vacation-month-chip');
      if (chip) {
        if (cb.checked) {
          chip.style.borderColor = 'var(--primary)';
          chip.style.backgroundColor = '#eff6ff';
          chip.style.color = 'var(--primary)';
          chip.style.fontWeight = '700';
        } else {
          chip.style.borderColor = '#cbd5e1';
          chip.style.backgroundColor = '#ffffff';
          chip.style.color = 'inherit';
          chip.style.fontWeight = 'normal';
        }
      }
    });

    const checkedCount = document.querySelectorAll('input[name="vacationMonth"]:checked').length;
    const countBadge = document.getElementById('vacationMonthsCountBadge');
    if (countBadge) {
      countBadge.textContent = checkedCount > 0 ? `ปิดเทอม ${checkedCount} เดือน (ค่าเช่า ฿0)` : 'ไม่มีเดือนปิดเทอม';
      countBadge.className = checkedCount > 0 ? 'pill-tag purple-tag' : 'pill-tag';
    }
  }

  bindEvents() {
    // Navigation
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.switchTab(e.currentTarget.dataset.tab);
      });
    });

    document.querySelectorAll('.mobile-bottom-nav .mobile-nav-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.switchTab(e.currentTarget.dataset.tab);
      });
    });

    // Support browser Back/Forward buttons and Hash changes
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.replace(/^#/, '');
      if (hash && document.getElementById(`tab-${hash}`)) {
        this.switchTab(hash, false, false);
      }
    });

    window.addEventListener('popstate', () => {
      const hash = window.location.hash.replace(/^#/, '');
      if (hash && document.getElementById(`tab-${hash}`)) {
        this.switchTab(hash, false, false);
      }
    });

    // Mobile Sidebar Drawer
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const closeSidebarBtn = document.getElementById('closeSidebarBtn');
    const sidebarBackdrop = document.getElementById('sidebarBackdrop');
    const sidebar = document.getElementById('sidebar');

    const toggleSidebar = (show) => {
      if (show) {
        if (sidebar) sidebar.classList.add('mobile-open');
        if (sidebarBackdrop) sidebarBackdrop.style.display = 'block';
      } else {
        if (sidebar) sidebar.classList.remove('mobile-open');
        if (sidebarBackdrop) sidebarBackdrop.style.display = 'none';
      }
    };

    if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', () => toggleSidebar(true));
    if (closeSidebarBtn) closeSidebarBtn.addEventListener('click', () => toggleSidebar(false));
    if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', () => toggleSidebar(false));

    // Mobile Quick Sale Button
    const quickSaleMobileBtn = document.getElementById('quickSaleMobileBtn');
    if (quickSaleMobileBtn) {
      quickSaleMobileBtn.addEventListener('click', () => {
        this.switchTab('today');
        document.getElementById('dailyFormRevenue')?.focus();
      });
    }

    // Header Quick Action Buttons
    const openAddSaleModalBtn = document.getElementById('openAddSaleModalBtn');
    if (openAddSaleModalBtn) {
      openAddSaleModalBtn.addEventListener('click', () => {
        this.switchTab('today');
        document.getElementById('dailyFormRevenue')?.focus();
      });
    }

    const openAddExpenseModalBtn = document.getElementById('openAddExpenseModalBtn');
    const btnOpenExpenseModal = document.getElementById('btnOpenExpenseModal');
    if (openAddExpenseModalBtn) openAddExpenseModalBtn.addEventListener('click', () => this.openExpenseModal());
    if (btnOpenExpenseModal) btnOpenExpenseModal.addEventListener('click', () => this.openExpenseModal());

    const btnOpenAddRecipeModal = document.getElementById('btnOpenAddRecipeModal');
    const recipeCreateMenu = document.getElementById('recipeCreateMenu');
    const btnOptionAddCupRecipe = document.getElementById('btnOptionAddCupRecipe');
    const btnOptionAddJarRecipe = document.getElementById('btnOptionAddJarRecipe');

    if (btnOpenAddRecipeModal && recipeCreateMenu) {
      btnOpenAddRecipeModal.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = recipeCreateMenu.style.display === 'block';
        recipeCreateMenu.style.display = isOpen ? 'none' : 'block';
      });

      document.addEventListener('click', (e) => {
        if (!e.target.closest('.recipe-create-dropdown-wrapper')) {
          recipeCreateMenu.style.display = 'none';
        }
      });

      if (btnOptionAddCupRecipe) {
        btnOptionAddCupRecipe.addEventListener('click', (e) => {
          e.stopPropagation();
          recipeCreateMenu.style.display = 'none';
          this.openRecipeModal(null, 'cup');
        });
      }

      if (btnOptionAddJarRecipe) {
        btnOptionAddJarRecipe.addEventListener('click', (e) => {
          e.stopPropagation();
          recipeCreateMenu.style.display = 'none';
          this.openRecipeModal(null, 'jar');
        });
      }
    } else if (btnOpenAddRecipeModal) {
      btnOpenAddRecipeModal.addEventListener('click', () => this.openRecipeModal(null, 'jar'));
    }

    // Recipe Search & Pill Filters (Tab 6 Figma Design)
    const recipeSearchInput = document.getElementById('recipeSearchInput');
    const btnClearRecipeSearch = document.getElementById('btnClearRecipeSearch');
    if (recipeSearchInput) {
      recipeSearchInput.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        if (btnClearRecipeSearch) {
          btnClearRecipeSearch.style.display = val ? 'flex' : 'none';
        }
        this.recipeSearchQuery = val;
        this.renderRecipes();
      });
    }

    if (btnClearRecipeSearch) {
      btnClearRecipeSearch.addEventListener('click', () => {
        if (recipeSearchInput) recipeSearchInput.value = '';
        btnClearRecipeSearch.style.display = 'none';
        this.recipeSearchQuery = '';
        this.renderRecipes();
        if (recipeSearchInput) recipeSearchInput.focus();
      });
    }

    const recipePills = document.querySelectorAll('#recipeFilterPills .figma-pill-filter');
    recipePills.forEach(pill => {
      pill.addEventListener('click', () => {
        const filter = pill.getAttribute('data-filter') || 'all';
        this.setRecipeFilter(filter);
      });
    });

    // Switch to Today tab from Dashboard
    document.querySelectorAll('[data-action="goToToday"]').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab('today'));
    });

    // Dashboard Month & Multi-Month Period Change
    const dashMonthSelect = document.getElementById('dashboardMonthSelect');
    if (dashMonthSelect) {
      dashMonthSelect.addEventListener('change', () => this.renderDashboard());
    }

    const rangeStart = document.getElementById('dashRangeStartMonth');
    const rangeEnd = document.getElementById('dashRangeEndMonth');
    if (rangeStart) rangeStart.addEventListener('change', () => this.renderDashboard());
    if (rangeEnd) rangeEnd.addEventListener('change', () => this.renderDashboard());

    document.querySelectorAll('input[name="dashPeriodMode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const mode = e.target.value;
        const singleBox = document.getElementById('dashSingleMonthBox');
        const customBox = document.getElementById('dashCustomRangeBox');

        // Update active class on pill buttons
        document.querySelectorAll('#dashPeriodPresets .figma-pill-label').forEach(label => {
          const input = label.querySelector('input[name="dashPeriodMode"]');
          const pill = label.querySelector('.figma-pill-filter');
          if (pill) {
            pill.classList.toggle('active', !!(input && input.checked));
          }
        });

        if (mode === 'single') {
          if (singleBox) singleBox.style.display = 'inline-flex';
          if (customBox) customBox.style.display = 'none';
        } else if (mode === 'custom') {
          if (singleBox) singleBox.style.display = 'none';
          if (customBox) customBox.style.display = 'flex';
        } else {
          // 3months, 6months, all
          if (singleBox) singleBox.style.display = 'none';
          if (customBox) customBox.style.display = 'none';
        }
        this.renderDashboard();
      });
    });

    // Date change on Today Tab
    const todayInput = document.getElementById('selectedTodayDateInput');
    if (todayInput) {
      todayInput.addEventListener('change', (e) => {
        const val = e.target.value;
        const dailyDate = document.getElementById('dailyFormDate');
        if (dailyDate) dailyDate.value = val;
        this.loadDailyFormForDate(val);
        this.renderTodaySummary(val);
      });
    }

    // Daily Form Date change
    const dailyFormDate = document.getElementById('dailyFormDate');
    if (dailyFormDate) {
      dailyFormDate.addEventListener('change', (e) => {
        const val = e.target.value;
        const todaySel = document.getElementById('selectedTodayDateInput');
        if (todaySel) todaySel.value = val;
        this.loadDailyFormForDate(val);
        this.renderTodaySummary(val);
      });
    }

    // Date Step Buttons (Prev Day, Next Day, Today, Yesterday, Picker trigger)
    const shiftDate = (days) => {
      const curDateStr = todayInput?.value || this.formatDate(new Date());
      const d = new Date(curDateStr + 'T00:00:00');
      d.setDate(d.getDate() + days);
      const newStr = this.formatDate(d);
      if (todayInput) todayInput.value = newStr;
      if (dailyFormDate) dailyFormDate.value = newStr;
      this.loadDailyFormForDate(newStr);
      this.renderTodaySummary(newStr);
    };

    document.getElementById('btnPrevDay')?.addEventListener('click', () => shiftDate(-1));
    document.getElementById('btnNextDay')?.addEventListener('click', () => shiftDate(1));

    document.getElementById('btnJumpToday')?.addEventListener('click', () => {
      const todayStr = this.formatDate(new Date());
      if (todayInput) todayInput.value = todayStr;
      if (dailyFormDate) dailyFormDate.value = todayStr;
      this.loadDailyFormForDate(todayStr);
      this.renderTodaySummary(todayStr);
    });

    document.getElementById('btnJumpYesterday')?.addEventListener('click', () => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const yStr = this.formatDate(d);
      if (todayInput) todayInput.value = yStr;
      if (dailyFormDate) dailyFormDate.value = yStr;
      this.loadDailyFormForDate(yStr);
      this.renderTodaySummary(yStr);
    });

    document.getElementById('btnJumpPicker')?.addEventListener('click', () => {
      if (todayInput) {
        if (typeof todayInput.showPicker === 'function') {
          todayInput.showPicker();
        } else {
          todayInput.focus();
        }
      }
    });

    // Live calculation listeners for daily revenue form
    const revInput = document.getElementById('dailyFormRevenue');
    const costInput = document.getElementById('dailyFormCost');
    const btnClearRevenue = document.getElementById('btnClearDailyRevenue');

    const toggleClearRevenueBtn = () => {
      if (btnClearRevenue && revInput) {
        btnClearRevenue.style.display = revInput.value ? 'flex' : 'none';
      }
    };

    if (revInput) {
      revInput.addEventListener('input', () => {
        toggleClearRevenueBtn();
        this.updateDailyLivePreview();
      });
    }
    if (costInput) costInput.addEventListener('input', () => this.updateDailyLivePreview());

    if (btnClearRevenue && revInput) {
      btnClearRevenue.addEventListener('click', () => {
        revInput.value = '';
        toggleClearRevenueBtn();
        revInput.focus();
        this.updateDailyLivePreview();
      });
    }

    // Quick Addition Chips (+50, +100, +500, +1000)
    document.querySelectorAll('.btn-chip-add, .figma-chip-btn').forEach(chip => {
      chip.addEventListener('click', (e) => {
        const addVal = parseFloat(e.currentTarget.dataset.add);
        const setVal = parseFloat(e.currentTarget.dataset.set);
        if (!revInput) return;

        let cur = parseFloat(revInput.value) || 0;
        if (!isNaN(addVal)) {
          cur += addVal;
        } else if (!isNaN(setVal)) {
          cur = setVal;
        }
        revInput.value = cur;
        toggleClearRevenueBtn();
        this.updateDailyLivePreview();
      });
    });

    // Embedded Touch Keypad (0-9, ., backspace)
    document.querySelectorAll('.figma-keypad-key').forEach(keyBtn => {
      keyBtn.addEventListener('click', (e) => {
        if (!revInput) return;
        const key = e.currentTarget.dataset.key;
        let val = revInput.value ? String(revInput.value) : '';

        if (key === 'backspace') {
          val = val.slice(0, -1);
        } else if (key === '.') {
          if (!val.includes('.')) {
            val = val === '' ? '0.' : val + '.';
          }
        } else if (key !== undefined) {
          // If val is '0', replace with new digit unless key is '.'
          if (val === '0') {
            val = key;
          } else {
            val += key;
          }
        }

        revInput.value = val;
        toggleClearRevenueBtn();
        this.updateDailyLivePreview();
      });
    });

    // Quick Note Tags
    document.querySelectorAll('.btn-note-tag, .figma-tag-btn').forEach(tag => {
      tag.addEventListener('click', (e) => {
        const noteInput = document.getElementById('dailyFormNote');
        const text = e.currentTarget.dataset.note || '';
        if (!noteInput || !text) return;
        if (noteInput.value.trim()) {
          noteInput.value += `, ${text}`;
        } else {
          noteInput.value = text;
        }
        noteInput.focus();
      });
    });

    // Quick Cost Preset Buttons (30%, 35%, 40%, etc.)
    document.querySelectorAll('.btn-preset-cost').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const pct = parseFloat(e.currentTarget.dataset.pct) || 35;
        const rev = parseFloat(document.getElementById('dailyFormRevenue')?.value) || 0;
        if (rev <= 0) {
          this.showToast('กรุณากรอกยอดขายก่อนกดปุ่มคิดต้นทุน', 'info');
          document.getElementById('dailyFormRevenue')?.focus();
          return;
        }
        const calcCost = Math.round(rev * (pct / 100));
        const cIn = document.getElementById('dailyFormCost');
        if (cIn) {
          cIn.value = calcCost;
          this.updateDailyLivePreview();
        }
      });
    });

    // Daily Revenue Form Submit
    const dailyForm = document.getElementById('dailyRevenueForm');
    if (dailyForm) {
      dailyForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveDailyRevenue();
      });
    }

    // Reset Daily Form Button
    const btnResetDaily = document.getElementById('btnResetDailyForm');
    if (btnResetDaily) {
      btnResetDaily.addEventListener('click', () => {
        this.clearDailyForm();
      });
    }

    // Expenses category filter
    const expCatFilter = document.getElementById('expenseCategoryFilter');
    if (expCatFilter) {
      expCatFilter.addEventListener('change', () => this.renderExpenses());
    }

    // Figma Expense Pill Filter Buttons
    document.querySelectorAll('.figma-pill-filter').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const cat = e.currentTarget.dataset.cat;
        this.setExpenseCategory(cat);
      });
    });

    // Pricing Calculator
    this.bindPricingCalc();

    // Calendar
    const calPrev = document.getElementById('calPrevMonthBtn');
    const calNext = document.getElementById('calNextMonthBtn');
    const calToday = document.getElementById('calTodayBtn');
    if (calPrev) calPrev.addEventListener('click', () => this.changeCalendarMonth(-1));
    if (calNext) calNext.addEventListener('click', () => this.changeCalendarMonth(1));
    if (calToday) calToday.addEventListener('click', () => {
      this.currentCalendarDate = new Date();
      this.selectedCalendarDayStr = this.formatDate(new Date());
      this.renderCalendar();
    });

    const calBtnAddSale = document.getElementById('calBtnAddSaleForThisDay');
    if (calBtnAddSale) {
      calBtnAddSale.addEventListener('click', () => {
        this.switchTab('today');
        const dailyDate = document.getElementById('dailyFormDate');
        const todaySel = document.getElementById('selectedTodayDateInput');
        if (dailyDate) dailyDate.value = this.selectedCalendarDayStr;
        if (todaySel) todaySel.value = this.selectedCalendarDayStr;
        this.loadDailyFormForDate(this.selectedCalendarDayStr);
        this.renderTodaySummary(this.selectedCalendarDayStr);
      });
    }

    const btnToggleDayHoliday = document.getElementById('btnToggleDayHoliday');
    if (btnToggleDayHoliday) {
      btnToggleDayHoliday.addEventListener('click', () => {
        this.toggleSelectedDayHoliday();
      });
    }

    const btnQuickBatchHoliday = document.getElementById('btnQuickBatchHoliday');
    if (btnQuickBatchHoliday) {
      btnQuickBatchHoliday.addEventListener('click', () => {
        this.openCustomHolidayModal();
      });
    }

    const btnHeaderBatchHoliday = document.getElementById('btnHeaderBatchHoliday');
    if (btnHeaderBatchHoliday) {
      btnHeaderBatchHoliday.addEventListener('click', () => {
        this.openCustomHolidayModal();
      });
    }

    // Modal month navigation
    const modalPrevMonthBtn = document.getElementById('holidayModalPrevMonthBtn');
    if (modalPrevMonthBtn) {
      modalPrevMonthBtn.addEventListener('click', () => {
        this.holidayPickerMonthDate.setMonth(this.holidayPickerMonthDate.getMonth() - 1);
        this.renderHolidayPickerGrid();
      });
    }

    const modalNextMonthBtn = document.getElementById('holidayModalNextMonthBtn');
    if (modalNextMonthBtn) {
      modalNextMonthBtn.addEventListener('click', () => {
        this.holidayPickerMonthDate.setMonth(this.holidayPickerMonthDate.getMonth() + 1);
        this.renderHolidayPickerGrid();
      });
    }

    // Quick select buttons
    const btnSelectSchoolDays = document.getElementById('holidayModalSelectSchoolDaysBtn');
    if (btnSelectSchoolDays) {
      btnSelectSchoolDays.addEventListener('click', () => {
        this.selectSchoolDaysForPickerMonth();
      });
    }

    const btnClearSelected = document.getElementById('holidayModalClearSelectedBtn');
    if (btnClearSelected) {
      btnClearSelected.addEventListener('click', () => {
        this.selectedBatchHolidayDates.clear();
        this.renderHolidayPickerGrid();
        this.renderHolidaySelectedChips();
      });
    }

    // Preset reason tags
    document.querySelectorAll('#holidayReasonPresets .preset-reason-pill, #holidayReasonPresets .preset-reason-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('#holidayReasonPresets .preset-reason-pill, #holidayReasonPresets .preset-reason-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const reasonInput = document.getElementById('holidayModalReasonInput');
        if (reasonInput) {
          reasonInput.value = btn.dataset.reason;
        }
      });
    });

    // Save batch holidays form submit
    const customHolidayForm = document.getElementById('customHolidayForm');
    if (customHolidayForm) {
      customHolidayForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveBatchHolidays();
      });
    }

    // Stock Filter Tabs & Search
    document.querySelectorAll('input[name="stockSubFilter"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const filterVal = e.target.value;
        const rows = document.querySelectorAll('#stockTableBody tr');
        rows.forEach(tr => {
          if (filterVal === 'all') {
            tr.style.display = '';
          } else if (filterVal === 'low') {
            const isLow = tr.dataset.isLow === 'true';
            tr.style.display = isLow ? '' : 'none';
          } else {
            const cat = tr.dataset.category;
            tr.style.display = (cat === filterVal) ? '' : 'none';
          }
        });
      });
    });

    const stockSearch = document.getElementById('stockSearchInput');
    if (stockSearch) {
      stockSearch.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        document.querySelectorAll('#stockTableBody tr').forEach(tr => {
          const text = tr.innerText.toLowerCase();
          tr.style.display = text.includes(query) ? '' : 'none';
        });
      });
    }

    // Sort order change listeners for Sales, Expenses, Recipes, and Stock
    const dailySalesSort = document.getElementById('dailySalesSortOrder');
    if (dailySalesSort) {
      dailySalesSort.addEventListener('change', () => this.renderDailyHistoryTable());
    }

    const expenseSort = document.getElementById('expenseSortOrder');
    if (expenseSort) {
      expenseSort.addEventListener('change', () => this.renderExpenses());
    }

    const recipeSort = document.getElementById('recipeSortOrder');
    if (recipeSort) {
      recipeSort.addEventListener('change', () => this.renderRecipes());
    }

    const stockSort = document.getElementById('stockSortOrder');
    if (stockSort) {
      stockSort.addEventListener('change', () => this.renderStock());
    }

    // Modal Close
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const modalId = e.currentTarget.dataset.close;
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('active');
      });
    });

    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          // ป้องกันไม่ให้คลิกด้านนอกแล้ว modal ปิดเองโดยไม่ได้ตั้งใจ (ต้องกดยกเลิก หรือบันทึกข้อมูลเท่านั้น)
          if (backdrop.id === 'recipeModal' || backdrop.id === 'expenseModal' || backdrop.id === 'stockItemModal') {
            return;
          }
          backdrop.classList.remove('active');
        }
      });
    });

    // Modal Sale Form Submit (for popups)
    const saleForm = document.getElementById('saleForm');
    if (saleForm) {
      saleForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const date = document.getElementById('saleDateInput').value;
        const revenue = parseFloat(document.getElementById('salePrice').value) || 0;
        const cost = parseFloat(document.getElementById('saleUnitCost').value) || 0;
        const note = document.getElementById('saleItemName').value.trim();

        this.recordDailySaleDirect(date, revenue, cost, note);
        document.getElementById('saleModal').classList.remove('active');
      });
    }

    // Modal sale inputs realtime preview
    ['salePrice', 'saleUnitCost'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => {
        const p = parseFloat(document.getElementById('salePrice')?.value) || 0;
        const c = parseFloat(document.getElementById('saleUnitCost')?.value) || 0;
        const pr = p - c;
        document.getElementById('modalSaleTotalPreview').textContent = this.formatCurrency(p);
        document.getElementById('modalCostTotalPreview').textContent = this.formatCurrency(c);
        document.getElementById('modalProfitTotalPreview').textContent = `${pr >= 0 ? '+' : ''}${this.formatCurrency(pr)}`;
      });
    });

    // Other Modals (Expense & Recipe)
    this.bindOtherForms();

    // Settings
    const btnSaveShopSettings = document.getElementById('btnSaveShopSettings');
    if (btnSaveShopSettings) {
      btnSaveShopSettings.addEventListener('click', () => {
        const name = document.getElementById('settingShopName')?.value.trim() || 'ร้านน้ำยายแต๊ป';
        const rent = parseFloat(document.getElementById('settingMonthlyRent')?.value) || 0;

        // Collect vacation months
        const selectedVacationMonths = [];
        document.querySelectorAll('input[name="vacationMonth"]:checked').forEach(cb => {
          selectedVacationMonths.push(parseInt(cb.value, 10));
        });

        this.data.shopSettings.name = name;
        this.data.shopSettings.monthlyRent = rent;
        this.data.shopSettings.vacationMonths = selectedVacationMonths.sort((a, b) => a - b);

        this.saveData();
        this.updateShopBranding();
        this.updateVacationMonthsUI();
        this.showToast(`บันทึกการตั้งค่าร้านค้า & เดือนปิดเทอมเรียบร้อยแล้ว`, 'success');
        this.renderDashboard();
        const todayDate = document.getElementById('dailyFormDate')?.value || this.formatDate(new Date());
        this.loadDailyFormForDate(todayDate);
        this.renderTodaySummary(todayDate);
      });
    }

    // Vacation Months Presets & Click Handlers
    document.querySelectorAll('input[name="vacationMonth"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const chip = cb.closest('.vacation-month-chip');
        if (chip) {
          if (cb.checked) {
            chip.style.borderColor = 'var(--primary)';
            chip.style.backgroundColor = '#eff6ff';
            chip.style.color = 'var(--primary)';
            chip.style.fontWeight = '700';
          } else {
            chip.style.borderColor = '#cbd5e1';
            chip.style.backgroundColor = '#ffffff';
            chip.style.color = 'inherit';
            chip.style.fontWeight = 'normal';
          }
        }
      });
    });

    const btnPresetSummer = document.getElementById('btnPresetSummerVacation');
    if (btnPresetSummer) {
      btnPresetSummer.addEventListener('click', () => {
        document.querySelectorAll('input[name="vacationMonth"]').forEach(cb => {
          const val = parseInt(cb.value, 10);
          if (val === 3 || val === 4) cb.checked = true; // มี.ค., เม.ย.
        });
        this.updateVacationChipsStyle();
      });
    }

    const btnPresetMidterm = document.getElementById('btnPresetMidtermVacation');
    if (btnPresetMidterm) {
      btnPresetMidterm.addEventListener('click', () => {
        document.querySelectorAll('input[name="vacationMonth"]').forEach(cb => {
          const val = parseInt(cb.value, 10);
          if (val === 10) cb.checked = true; // ต.ค.
        });
        this.updateVacationChipsStyle();
      });
    }

    const btnClearVac = document.getElementById('btnClearVacationMonths');
    if (btnClearVac) {
      btnClearVac.addEventListener('click', () => {
        document.querySelectorAll('input[name="vacationMonth"]').forEach(cb => {
          cb.checked = false;
        });
        this.updateVacationChipsStyle();
      });
    }

    // Export Data JSON
    const btnExportData = document.getElementById('btnExportData');
    if (btnExportData) {
      btnExportData.addEventListener('click', () => {
        const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(this.data, null, 2));
        const dlAnchor = document.createElement('a');
        dlAnchor.setAttribute('href', dataStr);
        dlAnchor.setAttribute('download', `waterflow_backup_${this.formatDate(new Date())}.json`);
        document.body.appendChild(dlAnchor);
        dlAnchor.click();
        dlAnchor.remove();
        this.showToast('ดาวน์โหลดไฟล์สำรองข้อมูลเรียบร้อยแล้ว', 'success');
      });
    }

    // Import Data JSON
    const importFileInput = document.getElementById('importFileInput');
    if (importFileInput) {
      importFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const imported = JSON.parse(event.target.result);
            if (imported.dailySales || imported.sales) {
              // Normalize if old schema
              if (!imported.dailySales && imported.sales) {
                imported.dailySales = this.migrateOldSales(imported.sales);
              }
              this.data = imported;
              this.saveData();
              this.initViews();
              this.showToast('นำเข้าข้อมูลสำเร็จทั้งหมด!', 'success');
            } else {
              this.showToast('ไฟล์ข้อมูลไม่ถูกต้องตามโครงสร้างระบบ', 'error');
            }
          } catch (err) {
            this.showToast('เกิดข้อผิดพลาดในการอ่านไฟล์ JSON', 'error');
          }
        };
        reader.readAsText(file);
      });
    }

    // Recipe ingredient dynamic row
    const btnAddIngredientRow = document.getElementById('btnAddIngredientRow');
    if (btnAddIngredientRow) {
      btnAddIngredientRow.addEventListener('click', () => {
        this.addIngredientRowToModal();
      });
    }

    const btnAddSingleCupRow = document.getElementById('btnAddSingleCupRow');
    if (btnAddSingleCupRow) {
      btnAddSingleCupRow.addEventListener('click', () => {
        this.addSingleCupRow();
      });
    }

    const btnSyncCupToBatch = document.getElementById('btnSyncCupToBatch');
    if (btnSyncCupToBatch) {
      btnSyncCupToBatch.addEventListener('click', () => {
        this.syncCupProportionsToBatch();
      });
    }
  }

  migrateOldSales(oldSales) {
    const map = {};
    oldSales.forEach(s => {
      if (!map[s.date]) {
        map[s.date] = { id: 'd_' + s.date, date: s.date, revenue: 0, cost: 0, profit: 0, note: '' };
      }
      map[s.date].revenue += Number(s.total) || 0;
      map[s.date].cost += Number(s.totalCost) || 0;
      map[s.date].profit += Number(s.profit) || 0;
    });
    return Object.values(map);
  }

  initViews() {
    const todayStr = this.formatDate(new Date());
    this.loadDailyFormForDate(todayStr);
    this.renderTodaySummary(todayStr);
    this.renderDashboard();
    this.renderExpenses();
    this.calculatePricing();
    this.renderSavedProducts();
    this.renderCalendar();
    this.renderRecipes();
    this.renderStock();

    // Restore active tab from URL hash or localStorage on page load/refresh (F5)
    let initialTab = 'dashboard';
    const hash = window.location.hash ? window.location.hash.replace(/^#/, '') : '';
    let savedTab = '';
    try {
      savedTab = localStorage.getItem('waterflow_active_tab') || '';
    } catch (e) {
      console.warn('Could not read localStorage waterflow_active_tab:', e);
    }

    const candidateTab = hash || savedTab;
    if (candidateTab) {
      const cleanCandidate = candidateTab.replace(/^tab-/, '');
      if (document.getElementById(`tab-${cleanCandidate}`)) {
        initialTab = cleanCandidate;
      }
    }

    this.switchTab(initialTab, true, false);
    this.refreshLucide();
  }

  refreshLucide() {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'success' ? 'toast-success' : type === 'error' ? 'toast-error' : ''}`;

    let iconName = 'info';
    if (type === 'success') iconName = 'check-circle-2';
    if (type === 'error') iconName = 'alert-triangle';

    toast.innerHTML = `<i data-lucide="${iconName}"></i><span>${message}</span>`;
    container.appendChild(toast);
    this.refreshLucide();

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  switchTab(tabId, updateState = true, smoothScroll = true) {
    if (!tabId) return;

    // Normalize tabId if passed with prefix
    const cleanTabId = tabId.replace(/^tab-/, '').replace(/^#/, '');

    document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === cleanTabId);
    });
    document.querySelectorAll('.mobile-bottom-nav .mobile-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === cleanTabId);
    });
    // If subhead clicked for stock, navigate to tab-stock or tab-stock-low
    const effectiveTabId = cleanTabId;

    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === `tab-${effectiveTabId}`);
    });

    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (backdrop) backdrop.style.display = 'none';

    if (cleanTabId === 'stock-low') {
      this.renderLowStockAlertView();
    } else if (cleanTabId === 'stock' || cleanTabId === 'stock-items') {
      const radioAll = document.querySelector('input[name="stockSubFilter"][value="all"]');
      if (radioAll) {
        radioAll.checked = true;
        radioAll.dispatchEvent(new Event('change'));
      }
      this.renderStock();
    } else if (cleanTabId === 'stock-history') {
      this.renderStockHistory();
    }

    if (cleanTabId === 'dashboard') {
      setTimeout(() => this.renderDashboardCharts(), 50);
    }
    if (cleanTabId === 'calendar') {
      this.renderCalendar();
    }

    if (updateState) {
      try {
        localStorage.setItem('waterflow_active_tab', cleanTabId);
        if (window.location.hash !== `#${cleanTabId}`) {
          history.replaceState(null, '', `#${cleanTabId}`);
        }
      } catch (e) {
        console.warn('Could not save tab state:', e);
      }
    }

    if (smoothScroll) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    this.refreshLucide();
  }

  // Helper to get active period filter info for dashboard
  getDashboardPeriodFilter() {
    const mode = document.querySelector('input[name="dashPeriodMode"]:checked')?.value || 'single';
    const singleInput = document.getElementById('dashboardMonthSelect');
    const selectedYM = singleInput ? singleInput.value : this.formatDate(new Date()).substring(0, 7);

    if (mode === 'single') {
      const [y, m] = selectedYM.split('-').map(Number);
      return {
        mode: 'single',
        label: `ประจำเดือน ${this.formatThaiMonthYear(y, m - 1)}`,
        shortLabel: 'ตลอดเดือน',
        monthsCount: 1,
        matchSale: (d) => d.date.startsWith(selectedYM),
        matchExpense: (e) => e.date.startsWith(selectedYM),
        monthsList: [selectedYM]
      };
    }

    if (mode === '3months' || mode === '6months') {
      const count = mode === '3months' ? 3 : 6;
      const now = new Date();
      const monthsList = [];
      for (let i = count - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        monthsList.push(this.formatDate(d).substring(0, 7));
      }
      const firstYM = monthsList[0];
      const lastYM = monthsList[monthsList.length - 1];
      const [y1, m1] = firstYM.split('-').map(Number);
      const [y2, m2] = lastYM.split('-').map(Number);

      return {
        mode,
        label: `สรุป ${count} เดือนล่าสุด (${this.formatThaiMonthYear(y1, m1 - 1)} - ${this.formatThaiMonthYear(y2, m2 - 1)})`,
        shortLabel: `${count} เดือนล่าสุด`,
        monthsCount: count,
        matchSale: (d) => monthsList.some(ym => d.date.startsWith(ym)),
        matchExpense: (e) => monthsList.some(ym => e.date.startsWith(ym)),
        monthsList
      };
    }

    if (mode === 'custom') {
      let startYM = document.getElementById('dashRangeStartMonth')?.value || selectedYM;
      let endYM = document.getElementById('dashRangeEndMonth')?.value || selectedYM;
      if (startYM > endYM) {
        const tmp = startYM;
        startYM = endYM;
        endYM = tmp;
      }
      const [y1, m1] = startYM.split('-').map(Number);
      const [y2, m2] = endYM.split('-').map(Number);

      // Generate list of YMs in range
      const monthsList = [];
      let cur = new Date(y1, m1 - 1, 1);
      const end = new Date(y2, m2 - 1, 1);
      while (cur <= end) {
        monthsList.push(this.formatDate(cur).substring(0, 7));
        cur.setMonth(cur.getMonth() + 1);
      }

      return {
        mode: 'custom',
        label: `ช่วง ${this.formatThaiMonthYear(y1, m1 - 1)} ถึง ${this.formatThaiMonthYear(y2, m2 - 1)} (${monthsList.length} เดือน)`,
        shortLabel: `${monthsList.length} เดือนที่เลือก`,
        monthsCount: monthsList.length || 1,
        matchSale: (d) => {
          const ym = d.date.substring(0, 7);
          return ym >= startYM && ym <= endYM;
        },
        matchExpense: (e) => {
          const ym = e.date.substring(0, 7);
          return ym >= startYM && ym <= endYM;
        },
        monthsList
      };
    }

    // mode === 'all'
    // Collect all unique months from sales and expenses
    const allMonthsSet = new Set();
    this.data.dailySales.forEach(s => allMonthsSet.add(s.date.substring(0, 7)));
    this.data.expenses.forEach(e => allMonthsSet.add(e.date.substring(0, 7)));
    if (allMonthsSet.size === 0) allMonthsSet.add(selectedYM);
    const sortedAllMonths = Array.from(allMonthsSet).sort();

    return {
      mode: 'all',
      label: `สรุปผลประกอบการทั้งหมดรวมทุกเดือน (${sortedAllMonths.length} เดือน)`,
      shortLabel: 'ทุกเดือนรวมกัน',
      monthsCount: sortedAllMonths.length || 1,
      matchSale: () => true,
      matchExpense: () => true,
      monthsList: sortedAllMonths
    };
  }

  // -------------------------------------------------------------------------
  // TAB 1: DASHBOARD
  // -------------------------------------------------------------------------
  renderDashboard() {
    const period = this.getDashboardPeriodFilter();
    const monthlyRentRate = this.data.shopSettings ? this.data.shopSettings.monthlyRent : 10000;

    // Calculate rent dynamically per month: 0 baht if vacation month
    let totalRentForPeriod = 0;
    let vacationMonthsInPeriod = 0;
    if (period.monthsList && period.monthsList.length > 0) {
      period.monthsList.forEach(ym => {
        const rentForThisMonth = this.getRentForMonth(ym);
        totalRentForPeriod += rentForThisMonth;
        if (this.isVacationMonth(ym)) {
          vacationMonthsInPeriod++;
        }
      });
    } else {
      totalRentForPeriod = monthlyRentRate * period.monthsCount;
    }

    // Toggle Vacation Month Badge in Dashboard Filter Header
    const vacBadge = document.getElementById('dashVacationMonthBadge');
    if (vacBadge) {
      if (period.mode === 'single' && this.isVacationMonth(period.monthsList[0])) {
        vacBadge.style.display = 'inline-flex';
        vacBadge.textContent = '🏖️ เดือนปิดเทอม (ค่าเช่า ฿0)';
      } else if (vacationMonthsInPeriod > 0) {
        vacBadge.style.display = 'inline-flex';
        vacBadge.textContent = `🏖️ รวมช่วงปิดเทอม ${vacationMonthsInPeriod} เดือน (เว้นค่าเช่า)`;
      } else {
        vacBadge.style.display = 'none';
      }
    }

    // Update Header description
    const descElem = document.getElementById('dashHeaderDesc');
    if (descElem) {
      descElem.textContent = `${period.label}`;
    }

    // Filter daily sales and expenses for the selected period
    const filteredDailySales = this.data.dailySales.filter(period.matchSale);
    const totalRevenue = filteredDailySales.reduce((acc, d) => acc + (Number(d.revenue) || 0), 0);

    const filteredExpenses = this.data.expenses.filter(period.matchExpense);
    const materialCost = filteredExpenses.reduce((acc, exp) => acc + (Number(exp.amount) || 0), 0);

    // Total Combined Cost = Material Cost in Period + Total Rent for all months in Period
    const totalCombinedCost = materialCost + totalRentForPeriod;

    // Net Profit = Total Revenue - Total Combined Cost
    const grossProfitBeforeRent = totalRevenue - materialCost;
    const netProfit = totalRevenue - totalCombinedCost;

    // Update Stat Card 1: ยอดขายรวม
    const salesCardLabel = document.querySelector('.revenue-card .stat-label');
    if (salesCardLabel) {
      salesCardLabel.textContent = `ยอดขายรวม (${period.shortLabel})`;
    }
    const totalSalesElem = document.getElementById('dashTotalSales');
    const totalSalesSubElem = document.getElementById('dashTotalSalesSub');
    if (totalSalesElem) totalSalesElem.textContent = this.formatCurrency(totalRevenue);
    if (totalSalesSubElem) totalSalesSubElem.textContent = this.formatCurrency(totalRevenue);

    const salesCountBadge = document.getElementById('dashSalesOrdersCount');
    if (salesCountBadge) salesCountBadge.textContent = `${filteredDailySales.length} วันที่บันทึก`;

    // Margin % for Hero Card
    const marginPct = totalRevenue > 0 ? ((netProfit / totalRevenue) * 100).toFixed(0) : 0;
    const marginPctElem = document.getElementById('dashProfitMarginPct');
    if (marginPctElem) marginPctElem.textContent = `${marginPct}%`;

    // Update Stat Card 2: ต้นทุนรวมทั้งหมด
    const totalCostElem = document.getElementById('dashTotalCost');
    if (totalCostElem) totalCostElem.textContent = this.formatCurrency(totalCombinedCost);
    const costRatioElem = document.getElementById('dashCostRatio');
    if (costRatioElem) {
      const rentDesc = totalRentForPeriod === 0
        ? `ค่าเช่า ฿0 (ปิดเทอม)`
        : `ค่าเช่าร้าน ${this.formatCurrency(totalRentForPeriod)}`;
      costRatioElem.textContent = `วัตถุดิบ ${this.formatCurrency(materialCost)} + ${rentDesc}`;
    }

    // Update Stat Card 3: ค่าเช่าร้าน
    const rentCardLabel = document.querySelector('.rent-card .stat-label');
    if (rentCardLabel) {
      rentCardLabel.textContent = `ค่าเช่าร้านรวม (${period.monthsCount} เดือน)`;
    }
    const rentDisplayElem = document.getElementById('dashRentDisplay');
    if (rentDisplayElem) rentDisplayElem.textContent = this.formatCurrency(totalRentForPeriod);
    const rentCardSub = document.querySelector('.rent-card .stat-subtext');
    if (rentCardSub) {
      if (period.mode === 'single' && this.isVacationMonth(period.monthsList[0])) {
        rentCardSub.textContent = '🏖️ ปิดเทอม ยกเว้นไม่คิดค่าเช่า';
      } else if (vacationMonthsInPeriod > 0) {
        rentCardSub.textContent = `ช่วงปิดเทอม ${vacationMonthsInPeriod} เดือน (ไม่คิดค่าเช่า)`;
      } else if (period.monthsCount > 1) {
        rentCardSub.textContent = `เดือนละ ${this.formatCurrency(monthlyRentRate)} × ${period.monthsCount} เดือน`;
      } else {
        rentCardSub.textContent = 'รวมอยู่ในต้นทุนทั้งหมดแล้ว';
      }
    }

    // Update Stat Card 4: ต้นทุนวัตถุดิบ
    const expCardVal = document.getElementById('dashMaterialExpense');
    const expCardSub = document.getElementById('dashExpenseCount');
    if (expCardVal) expCardVal.textContent = this.formatCurrency(materialCost);
    if (expCardSub) expCardSub.textContent = `${filteredExpenses.length} รายการที่ซื้อในช่วงนี้`;

    // Update Stat Card 5: กำไรสุทธิคงเหลือ
    const netProfitElem = document.getElementById('dashNetProfit');
    const profitStatusElem = document.getElementById('dashProfitStatus');
    const profitIconWrapper = document.getElementById('dashProfitIconWrapper');
    const profitCard = document.getElementById('dashProfitCard');

    if (netProfitElem) {
      if (netProfit < 0) {
        const absLoss = Math.abs(netProfit);
        netProfitElem.textContent = `-${this.formatCurrency(absLoss)}`;
        netProfitElem.className = 'fdh-amount text-danger';
        if (profitIconWrapper) profitIconWrapper.className = 'stat-icon-wrapper red';
        if (profitCard) {
          profitCard.style.borderTop = '4px solid var(--danger)';
          profitCard.style.background = 'linear-gradient(180deg, #fef2f2 0%, #ffffff 60%)';
        }
      } else {
        netProfitElem.textContent = `${netProfit > 0 ? '+' : ''}${this.formatCurrency(netProfit)}`;
        netProfitElem.className = 'fdh-amount';
        if (profitIconWrapper) profitIconWrapper.className = 'stat-icon-wrapper green';
        if (profitCard) {
          profitCard.style.borderTop = '4px solid var(--success)';
          profitCard.style.background = 'linear-gradient(180deg, #ecfdf5 0%, #ffffff 60%)';
        }
      }
    }

    if (profitStatusElem) {
      profitStatusElem.textContent = '';
      profitStatusElem.style.display = 'none';
    }

    // Rent Progress Bar in Sidebar
    const rentProgressPercent = totalRentForPeriod > 0 ? Math.min(100, Math.max(0, (grossProfitBeforeRent / totalRentForPeriod) * 100)) : 100;
    const progressBar = document.getElementById('rentProgressBar');
    const progressText = document.getElementById('rentProgressText');
    if (progressBar) progressBar.style.width = `${rentProgressPercent.toFixed(0)}%`;
    if (progressText) {
      if (grossProfitBeforeRent >= totalRentForPeriod) {
        progressText.textContent = `กำไรครอบคลุมค่าเช่าร้านแล้ว! (${rentProgressPercent.toFixed(0)}%)`;
        progressText.style.color = '#047857';
      } else {
        progressText.textContent = `กำไรเบื้องต้น ฿${grossProfitBeforeRent.toLocaleString()} / ฿${totalRentForPeriod.toLocaleString()} (${rentProgressPercent.toFixed(0)}%)`;
        progressText.style.color = '#7e22ce';
      }
    }

    // Recent Daily Sales Table in Dashboard
    this.renderDashboardRecentSales(filteredDailySales);

    // Performance Stats in Dashboard
    this.renderDashboardPerformance(filteredDailySales, totalRevenue, netProfit);

    // Charts
    this.renderDashboardCharts(filteredDailySales, totalRevenue, materialCost, totalRentForPeriod, netProfit, period);
  }

  renderDashboardRecentSales(monthDailySales) {
    const tbody = document.getElementById('dashRecentSalesTableBody');
    const cardsFeed = document.getElementById('dashRecentSalesCardsFeed');

    const sorted = [...monthDailySales].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);

    // 1. Render Mobile & Desktop Unified Cards Stream
    if (cardsFeed) {
      if (sorted.length === 0) {
        cardsFeed.innerHTML = `
          <div class="figma-tx-empty">
            <div class="figma-empty-icon"><i data-lucide="calendar-x"></i></div>
            <div class="figma-empty-text">ยังไม่มีข้อมูลการขายในเดือนนี้</div>
            <div class="figma-empty-sub">แตะปุ่ม "+ บันทึกยอดวันนี้" ด้านบนเพื่อเริ่มบันทึก</div>
          </div>
        `;
      } else {
        cardsFeed.innerHTML = sorted.map(d => {
          const profit = Number(d.profit) || 0;
          const isProfit = profit >= 0;
          const profitFormatted = isProfit ? `+${this.formatCurrency(profit)}` : `-${this.formatCurrency(Math.abs(profit))}`;
          const isOpen = !this.isWeekend(d.date) && !this.isPublicHoliday(d.date) && !this.getCustomHoliday(d.date);

          return `
            <div class="figma-tx-card ${isProfit ? 'is-profit' : 'is-loss'}">
              <div class="figma-tx-main">
                <div class="figma-tx-left">
                  <div class="figma-tx-avatar">
                    <i data-lucide="${isProfit ? 'trending-up' : 'trending-down'}"></i>
                  </div>
                  <div class="figma-tx-meta">
                    <div class="figma-tx-date-row">
                      <span class="figma-tx-date">${this.formatThaiDate(d.date)}</span>
                      <span class="figma-tx-pill ${isOpen ? 'open' : 'holiday'}">
                        ${isOpen ? 'วันเปิดเรียน' : 'วันหยุด'}
                      </span>
                    </div>
                    <div class="figma-tx-sub">
                      <span>ทุน: <strong class="figma-tx-cost-num">${this.formatCurrency(d.cost)}</strong></span>
                      ${d.note ? `<span>• ${this.escapeHtml(d.note)}</span>` : ''}
                    </div>
                  </div>
                </div>
                <div class="figma-tx-right">
                  <span class="figma-tx-revenue">${this.formatCurrency(d.revenue)}</span>
                  <span class="figma-tx-profit-pill ${isProfit ? 'profit' : 'loss'}">
                    ${profitFormatted}
                  </span>
                </div>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // 2. Fallback Table (for compatibility)
    if (tbody) {
      if (sorted.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-4">ไม่มีข้อมูลการขายในเดือนนี้</td></tr>`;
        return;
      }

      tbody.innerHTML = sorted.map(d => {
        const profit = Number(d.profit) || 0;
        const isProfit = profit >= 0;
        const profitFormatted = isProfit ? `+${this.formatCurrency(profit)}` : `-${this.formatCurrency(Math.abs(profit))}`;
        const profitBadgeClass = isProfit ? 'pill-tag green-tag' : 'pill-tag red-tag';

        return `
          <tr>
            <td>
              <div class="font-bold text-main" style="font-size:0.9rem;">${this.formatThaiDate(d.date)}</div>
            </td>
            <td>
              <span class="font-bold text-primary" style="font-size:0.95rem;">${this.formatCurrency(d.revenue)}</span>
            </td>
            <td>
              <span class="font-semibold text-amber" style="font-size:0.9rem;">${this.formatCurrency(d.cost)}</span>
            </td>
            <td>
              <span class="${profitBadgeClass}" style="font-weight:700; font-size:0.8rem;">${profitFormatted}</span>
            </td>
            <td>
              <span class="text-sm text-muted">${this.escapeHtml(d.note || '-')}</span>
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  renderDashboardPerformance(monthDailySales, totalRevenue, grossProfit) {
    const daysCount = monthDailySales.length;
    const avgSales = daysCount > 0 ? (totalRevenue / daysCount) : 0;
    const avgProfit = daysCount > 0 ? (grossProfit / daysCount) : 0;
    const avgMargin = totalRevenue > 0 ? ((grossProfit / totalRevenue) * 100) : 0;

    let bestDayStr = '-';
    if (daysCount > 0) {
      const best = [...monthDailySales].sort((a, b) => b.revenue - a.revenue)[0];
      bestDayStr = `${this.formatThaiDate(best.date, false)} (${this.formatCurrency(best.revenue)})`;
    }

    const statDays = document.getElementById('statDaysRecorded');
    const statAvgSales = document.getElementById('statAvgDailySales');
    const statAvgProfit = document.getElementById('statAvgDailyProfit');
    const statAvgMargin = document.getElementById('statAvgMargin');
    const statBestDay = document.getElementById('statBestDay');

    const isProfit = avgProfit >= 0;
    const isMarginPositive = avgMargin >= 0;

    if (statDays) statDays.textContent = `${daysCount} วัน`;
    if (statAvgSales) statAvgSales.textContent = this.formatCurrency(avgSales);

    if (statAvgProfit) {
      statAvgProfit.textContent = isProfit ? `+${this.formatCurrency(avgProfit)}` : `-${this.formatCurrency(Math.abs(avgProfit))}`;
      statAvgProfit.className = `font-bold ${isProfit ? 'text-green' : 'text-danger'}`;
    }

    if (statAvgMargin) {
      statAvgMargin.textContent = `${isMarginPositive ? '+' : ''}${avgMargin.toFixed(1)}%`;
      statAvgMargin.className = `font-bold ${isMarginPositive ? 'text-green' : 'text-danger'}`;
    }

    if (statBestDay) statBestDay.textContent = bestDayStr;

    // Render Top 3 Most Used Stock Items (เฉพาะสินค้าสำเร็จรูป/น้ำยกลัง)
    const topStockListElem = document.getElementById('dashTopStockItemsList');
    if (topStockListElem) {
      const logs = this.data.stockLogs || [];
      const stockItems = this.data.stockItems || [];
      const usageMap = {};

      // Helper to check if item is a crate/boxed bottled drink
      const isCaseDrink = (name) => {
        const lower = (name || '').toLowerCase();
        const found = stockItems.find(s => s.name.toLowerCase() === lower);
        if (found && found.category === 'STOCK') return true;
        return lower.includes('ลัง') || lower.includes('ขวด') || lower.includes('ยกลัง') || lower.includes('สำเร็จรูป');
      };

      // 1. Tally from actual logs if available
      logs.forEach(log => {
        if (log.actionType === 'USE' && log.changeQty < 0 && isCaseDrink(log.itemName)) {
          const name = log.itemName;
          const qty = Math.abs(log.changeQty);
          if (!usageMap[name]) {
            usageMap[name] = { name: name, qty: 0, unit: log.unit || 'ลัง' };
          }
          usageMap[name].qty += qty;
        }
      });

      let topItems = Object.values(usageMap).sort((a, b) => b.qty - a.qty);

      if (topItems.length === 0) {
        topStockListElem.innerHTML = `
          <div class="text-center text-muted py-3" style="font-size:0.8rem; background:#f8fafc; border:1px dashed var(--border-color); border-radius:var(--radius-sm);">
            ยังไม่มีประวัติการเบิกขายน้ำยกลังในเดือนนี้
          </div>
        `;
        return;
      }

      const top3 = topItems.slice(0, 3);

      topStockListElem.innerHTML = top3.map((item, idx) => {
        const rankBadge = ['🥇', '🥈', '🥉'][idx] || `#${idx + 1}`;

        return `
          <div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:0.45rem 0.65rem; font-size:0.825rem;">
            <div style="display:flex; align-items:center; gap:0.45rem; overflow:hidden;">
              <span style="font-size:0.9rem;">${rankBadge}</span>
              <span class="font-bold text-main" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(item.name)}</span>
            </div>
            <div style="text-align:right; flex-shrink:0;">
              <b class="text-primary">${item.qty}</b> <span class="text-xs text-muted">${this.escapeHtml(item.unit)}</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  renderDashboardCharts(filteredDailySales = null, totalRevenue = 0, totalCost = 0, totalRent = 10000, netProfit = 0, period = null) {
    if (!window.Chart) return;

    if (!period) {
      period = this.getDashboardPeriodFilter();
    }

    if (!filteredDailySales) {
      filteredDailySales = this.data.dailySales.filter(period.matchSale);
      totalRevenue = filteredDailySales.reduce((acc, d) => acc + (Number(d.revenue) || 0), 0);
      const filteredExpenses = this.data.expenses.filter(period.matchExpense);
      totalCost = filteredExpenses.reduce((acc, exp) => acc + (Number(exp.amount) || 0), 0);
      totalRent = 0;
      if (period.monthsList && period.monthsList.length > 0) {
        period.monthsList.forEach(ym => {
          totalRent += this.getRentForMonth(ym);
        });
      } else {
        const monthlyRentRate = this.data.shopSettings?.monthlyRent || 10000;
        totalRent = monthlyRentRate * period.monthsCount;
      }
      netProfit = totalRevenue - (totalCost + totalRent);
    }

    // 1. Trend Chart (Daily if single month, Monthly bar/line if multi-month)
    const ctxTrend = document.getElementById('monthlyTrendChart');
    if (ctxTrend) {
      let labels = [];
      let revData = [];
      let profitData = [];

      const chartTitleElem = document.getElementById('dashTrendChartTitle');
      if (period.mode === 'single') {
        if (chartTitleElem) chartTitleElem.textContent = 'กราฟแนวโน้มยอดขาย & กำไรสุทธิรายวัน (วันที่ 1 - 31)';
        const selectedYM = period.monthsList[0];
        const [yearStr, monthStr] = selectedYM.split('-');
        const daysInMonth = new Date(parseInt(yearStr), parseInt(monthStr), 0).getDate();

        const dayMap = {};
        for (let d = 1; d <= daysInMonth; d++) {
          const dStr = `${selectedYM}-${String(d).padStart(2, '0')}`;
          dayMap[dStr] = { revenue: 0, profit: 0, dayLabel: `${d}` };
        }

        filteredDailySales.forEach(d => {
          if (dayMap[d.date]) {
            dayMap[d.date].revenue = Number(d.revenue) || 0;
            dayMap[d.date].profit = Number(d.profit) || 0;
          }
        });

        labels = Object.values(dayMap).map(v => v.dayLabel);
        revData = Object.values(dayMap).map(v => v.revenue);
        profitData = Object.values(dayMap).map(v => v.profit);
      } else {
        // Multi-month: Show month names on X axis (เช่น ม.ค., ก.พ., มี.ค.)
        if (chartTitleElem) chartTitleElem.textContent = `กราฟเปรียบเทียบยอดขาย & กำไรสุทธิแยกตามเดือน (${period.shortLabel})`;
        const thaiShortMonths = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
        const monthMap = {};
        period.monthsList.forEach(ym => {
          const [y, m] = ym.split('-').map(Number);
          monthMap[ym] = {
            label: `${thaiShortMonths[m - 1]} ${String(y + 543).slice(-2)}`,
            revenue: 0,
            profit: 0
          };
        });

        filteredDailySales.forEach(d => {
          const ym = d.date.substring(0, 7);
          if (monthMap[ym]) {
            monthMap[ym].revenue += Number(d.revenue) || 0;
            monthMap[ym].profit += Number(d.profit) || 0;
          }
        });

        labels = Object.values(monthMap).map(v => v.label);
        revData = Object.values(monthMap).map(v => v.revenue);
        profitData = Object.values(monthMap).map(v => v.profit);
      }

      if (this.charts.trend) {
        this.charts.trend.destroy();
      }

      this.charts.trend = new Chart(ctxTrend, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'ยอดขายที่ได้ (บาท)',
              data: revData,
              backgroundColor: 'rgba(0, 80, 240, 0.75)',
              borderRadius: 4,
              order: 2
            },
            {
              label: 'กำไรสุทธิ (บาท)',
              data: profitData,
              type: 'line',
              borderColor: '#10b981',
              backgroundColor: '#10b981',
              borderWidth: 2.5,
              tension: 0.3,
              pointRadius: 2.5,
              order: 1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'top',
              labels: { font: { family: 'Sarabun', size: 12 } }
            },
            tooltip: {
              titleFont: { family: 'Sarabun' },
              bodyFont: { family: 'Sarabun' }
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { font: { family: 'Sarabun' } }
            },
            y: {
              beginAtZero: true,
              ticks: {
                font: { family: 'Sarabun' },
                callback: (val) => '฿' + val
              }
            }
          }
        }
      });
    }

    // 2. Breakdown Doughnut
    const ctxDoughnut = document.getElementById('costBreakdownChart');
    if (ctxDoughnut) {
      if (this.charts.breakdown) {
        this.charts.breakdown.destroy();
      }

      const safeProfit = Math.max(0, netProfit);
      this.charts.breakdown = new Chart(ctxDoughnut, {
        type: 'doughnut',
        data: {
          labels: ['ต้นทุนของที่ใช้ไป', 'ค่าเช่าร้าน', 'กำไรสุทธิคงเหลือ'],
          datasets: [{
            data: [totalCost, totalRent, safeProfit],
            backgroundColor: ['#f59e0b', '#8b5cf6', '#10b981'],
            borderWidth: 2,
            borderColor: '#ffffff'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'bottom',
              labels: { font: { family: 'Sarabun', size: 12 }, boxWidth: 12 }
            },
            tooltip: {
              titleFont: { family: 'Sarabun' },
              bodyFont: { family: 'Sarabun' },
              callbacks: {
                label: (ctx) => ` ${ctx.label}: ฿${ctx.parsed.toLocaleString()}`
              }
            }
          },
          cutout: '65%'
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // TAB 2: TODAY SALES & DAILY ENTRY FORM (ต้นทุนดึงอัตโนมัติจากระบบ)
  // -------------------------------------------------------------------------
  getSystemCostForDate(dateStr, inputRevenue = null) {
    const monthlyRent = this.data.shopSettings ? this.data.shopSettings.monthlyRent : 10000;
    const isSchoolOpen = this.isSchoolOpenDay(dateStr);
    const isWk = this.isWeekend(dateStr);
    const isHol = this.isHoliday(dateStr);

    // ค่าเช่าเฉพาะวันเปิดขายที่โรงเรียน (วันหยุดเสาร์-อาทิตย์, นักขัตฤกษ์ และช่วงปิดเทอม = 0 บาท)
    let dailyRent = 0;
    let rentLabel = '';

    if (this.isVacationMonth(dateStr)) {
      dailyRent = 0;
      rentLabel = `🏖️ ช่วงเดือนปิดเทอม (ยกเว้นไม่คิดค่าเช่าร้าน ฿0)`;
    } else if (isSchoolOpen) {
      dailyRent = this.getDailyRentForSchoolDay(dateStr);
      const openDaysCount = this.getSchoolOpenDaysCount(dateStr.substring(0, 7));
      rentLabel = `ค่าเช่าเฉลี่ยวันเปิดเรียน ฿${dailyRent.toLocaleString()}/วัน (เดือนนี้เปิดขายจริง ${openDaysCount} วัน)`;
    } else {
      dailyRent = 0;
      if (isHol) {
        rentLabel = `วันหยุดนักขัตฤกษ์/วันหยุดโรงเรียน (ไม่คิดค่าเช่าประจำวัน)`;
      } else {
        rentLabel = `วันหยุดเสาร์-อาทิตย์ โรงเรียนปิด (ไม่คิดค่าเช่าประจำวัน)`;
      }
    }

    // คำนวณต้นทุนวัตถุดิบเฉลี่ยต่อวันเปิดเรียน (ยอดรวมวัตถุดิบของเดือน หารด้วย จำนวนวันที่เปิดเรียน)
    const ym = dateStr.substring(0, 7);
    const openDaysCount = this.getSchoolOpenDaysCount(ym);
    const monthExpenses = this.data.expenses.filter(e => e.date.startsWith(ym));
    const monthExpenseTotal = monthExpenses.reduce((acc, exp) => acc + (Number(exp.amount) || 0), 0);

    let materialCost = 0;
    let materialSource = '';

    if (isSchoolOpen) {
      if (monthExpenseTotal > 0 && openDaysCount > 0) {
        // วัตถุดิบหารเฉลี่ยตามจำนวนวันที่โรงเรียนเปิดเทอม
        materialCost = Math.round(monthExpenseTotal / openDaysCount);
        materialSource = `วัตถุดิบเฉลี่ย ฿${materialCost.toLocaleString()}/วัน (ซื้อรวม ฿${monthExpenseTotal.toLocaleString()} ÷ ${openDaysCount} วันเปิดเรียน)`;
      } else {
        // กรณีเดือนนี้ยังไม่มีการลงบันทึกรายจ่ายซื้อของ
        materialCost = 0;
        materialSource = `ยังไม่มีบันทึกซื้อวัตถุดิบเดือนนี้ (฿0)`;
      }
    } else {
      // วันหยุดโรงเรียน (เสาร์-อาทิตย์ หรือวันหยุดพิเศษ)
      materialCost = 0;
      materialSource = `วันหยุดโรงเรียน (ไม่คิดต้นทุนประจำวัน)`;
    }

    // ต้นทุนรวมทั้งหมดวันนี้ = ต้นทุนวัตถุดิบเฉลี่ย + ค่าเช่าร้านเฉลี่ยวันเปิดเรียน
    const totalCost = materialCost + dailyRent;

    return {
      materialCost: materialCost,
      dailyRent: dailyRent,
      isSchoolOpen: isSchoolOpen,
      isWeekend: isWk,
      isHoliday: isHol,
      cost: totalCost,
      source: 'AVERAGE_OPEN_DAYS',
      label: isSchoolOpen
        ? `วัตถุดิบเฉลี่ย ฿${materialCost.toLocaleString()} + ค่าเช่า ฿${dailyRent.toLocaleString()} = รวม ฿${totalCost.toLocaleString()} (เฉลี่ย ${openDaysCount} วันเปิดเรียน)`
        : `วันหยุดโรงเรียน (ต้นทุนรวม ฿0)`
    };
  }

  loadDailyFormForDate(dateStr) {
    const existing = this.data.dailySales.find(d => d.date === dateStr);
    const headerTitle = document.getElementById('dailyFormHeaderTitle');
    const modeTag = document.getElementById('dailyFormModeTag');
    const recIdInput = document.getElementById('dailyRecordId');
    const revInput = document.getElementById('dailyFormRevenue');
    const costInput = document.getElementById('dailyFormCost');
    const noteInput = document.getElementById('dailyFormNote');
    const btnReset = document.getElementById('btnResetDailyForm');
    const btnSaveText = document.querySelector('#btnSaveDailyRevenue span');

    if (existing) {
      if (headerTitle) headerTitle.textContent = `แก้ไขยอดขายวันที่ ${this.formatThaiDate(dateStr)}`;
      if (modeTag) {
        modeTag.textContent = 'แก้ไขยอดเดิม';
        modeTag.className = 'pill-tag amber-tag';
      }
      if (recIdInput) recIdInput.value = existing.id;
      if (revInput) revInput.value = existing.revenue;
      if (costInput) costInput.value = existing.cost;
      if (noteInput) noteInput.value = existing.note || '';
      if (btnReset) btnReset.style.display = 'inline-block';
      if (btnSaveText) btnSaveText.textContent = 'อัปเดตยอดเงินวันนี้';
      this.updateDailyLivePreview(false);
    } else {
      if (headerTitle) headerTitle.textContent = `กรอกยอดเงินที่ขายได้ประจำวัน (${this.formatThaiDate(dateStr)})`;
      if (modeTag) {
        modeTag.textContent = 'บันทึกยอดใหม่';
        modeTag.className = 'pill-tag blue-tag';
      }
      if (recIdInput) recIdInput.value = '';
      if (revInput) revInput.value = '';
      if (costInput) costInput.value = '';
      if (noteInput) noteInput.value = '';
      if (btnReset) btnReset.style.display = 'none';
      if (btnSaveText) btnSaveText.textContent = 'บันทึกยอดเงินวันนี้';
      this.updateDailyLivePreview(true);
    }
  }

  updateDailyLivePreview(recalcSystemCost = false) {
    const dateStr = document.getElementById('dailyFormDate')?.value || this.formatDate(new Date());
    const revInput = document.getElementById('dailyFormRevenue');
    const rev = parseFloat(revInput?.value) || 0;

    const costInput = document.getElementById('dailyFormCost');
    const sourceHint = document.getElementById('dailyCostSourceHint');

    const costInfo = this.getSystemCostForDate(dateStr, rev);
    if (recalcSystemCost || !costInput?.value) {
      if (costInput) costInput.value = costInfo.cost;
    }
    if (sourceHint) sourceHint.textContent = '';

    const cost = parseFloat(costInput?.value) || 0;
    const profit = rev - cost;
    const margin = rev > 0 ? ((profit / rev) * 100) : 0;

    const prevRev = document.getElementById('previewDailyRevenue');
    const prevCost = document.getElementById('previewDailyCost');
    const prevProfit = document.getElementById('previewDailyProfit');
    const prevMargin = document.getElementById('previewDailyMargin');
    const resultBox = document.getElementById('previewDailyResultBox');
    const resultLabel = document.getElementById('previewResultLabel');

    if (prevRev) prevRev.textContent = this.formatCurrency(rev);
    if (prevCost) prevCost.textContent = this.formatCurrency(cost);

    if (profit >= 0) {
      if (resultLabel) resultLabel.textContent = 'กำไรสุทธิวันนี้:';
      if (prevProfit) {
        prevProfit.textContent = `+${this.formatCurrency(profit)}`;
        prevProfit.className = 'calc-val text-green font-extrabold';
      }
      if (prevMargin) {
        prevMargin.textContent = `(กำไร ${margin.toFixed(1)}%)`;
        prevMargin.style.color = '#047857';
      }
      if (resultBox) {
        resultBox.className = 'calc-col highlight-result';
      }
    } else {
      if (resultLabel) resultLabel.textContent = 'ขาดทุนวันนี้:';
      const absLoss = Math.abs(profit);
      if (prevProfit) {
        prevProfit.textContent = `-${this.formatCurrency(absLoss)}`;
        prevProfit.className = 'calc-val text-danger font-extrabold';
      }
      if (prevMargin) {
        prevMargin.textContent = `(ขาดทุน)`;
        prevMargin.style.color = '#dc2626';
      }
      if (resultBox) {
        resultBox.className = 'calc-col highlight-result loss';
      }
    }

    const btnClearRevenue = document.getElementById('btnClearDailyRevenue');
    if (btnClearRevenue) {
      btnClearRevenue.style.display = rev > 0 ? 'flex' : 'none';
    }
  }

  clearDailyForm() {
    document.getElementById('dailyRecordId').value = '';
    document.getElementById('dailyFormRevenue').value = '';
    document.getElementById('dailyFormCost').value = '';
    document.getElementById('dailyFormNote').value = '';
    document.getElementById('btnResetDailyForm').style.display = 'none';
    const btnClearRevenue = document.getElementById('btnClearDailyRevenue');
    const modeTag = document.getElementById('dailyFormModeTag');
    if (modeTag) {
      modeTag.textContent = 'บันทึกยอดใหม่';
      modeTag.className = 'pill-tag blue-tag';
    }
    const saveBtnSpan = document.querySelector('#btnSaveDailyRevenue span');
    if (saveBtnSpan) saveBtnSpan.textContent = 'บันทึกยอดเงินวันนี้';
    this.updateDailyLivePreview();
  }

  saveDailyRevenue() {
    const date = document.getElementById('dailyFormDate').value;
    const revenue = parseFloat(document.getElementById('dailyFormRevenue').value) || 0;
    // ต้นทุนดึงจากระบบอัตโนมัติ
    const cost = parseFloat(document.getElementById('dailyFormCost').value) || 0;
    const note = document.getElementById('dailyFormNote').value.trim();
    const profit = revenue - cost;

    if (!date) {
      this.showToast('กรุณาระบุวันที่ขาย', 'error');
      return;
    }

    const existingIndex = this.data.dailySales.findIndex(d => d.date === date);
    const costInfo = this.getSystemCostForDate(date, revenue);
    const materialCost = costInfo.materialCost;
    const dailyRent = costInfo.dailyRent;

    if (existingIndex !== -1) {
      this.data.dailySales[existingIndex] = {
        ...this.data.dailySales[existingIndex],
        revenue,
        cost,
        materialCost,
        dailyRent,
        profit,
        note
      };
      if (profit >= 0) {
        this.showToast(`อัปเดตยอดขายวันที่ ${this.formatThaiDate(date)} สำเร็จ! (กำไรสุทธิ +${this.formatCurrency(profit)})`, 'success');
      } else {
        this.showToast(`อัปเดตยอดขายวันที่ ${this.formatThaiDate(date)} (ขาดทุน -${this.formatCurrency(Math.abs(profit))})`, 'error');
      }
    } else {
      const newRecord = {
        id: 'd_' + Date.now(),
        date,
        revenue,
        cost,
        materialCost,
        dailyRent,
        profit,
        note
      };
      this.data.dailySales.unshift(newRecord);
      if (profit >= 0) {
        this.showToast(`บันทึกยอดขายวันที่ ${this.formatThaiDate(date)} เรียบร้อย! (กำไรสุทธิ +${this.formatCurrency(profit)})`, 'success');
      } else {
        this.showToast(`บันทึกยอดขายวันที่ ${this.formatThaiDate(date)} (ขาดทุน -${this.formatCurrency(Math.abs(profit))})`, 'error');
      }
    }

    this.saveData();
    this.renderTodaySummary(date);
    this.renderDashboard();
    this.renderCalendar();
  }

  recordDailySaleDirect(date, revenue, cost, note) {
    const costInfo = this.getSystemCostForDate(date, revenue);
    const dailyRent = costInfo.dailyRent;
    const materialCost = Math.max(0, cost - dailyRent);
    const profit = revenue - cost;
    const existingIndex = this.data.dailySales.findIndex(d => d.date === date);

    if (existingIndex !== -1) {
      this.data.dailySales[existingIndex] = {
        ...this.data.dailySales[existingIndex],
        revenue,
        cost,
        materialCost,
        dailyRent,
        profit,
        note
      };
    } else {
      this.data.dailySales.unshift({
        id: 'd_' + Date.now(),
        date,
        revenue,
        cost,
        materialCost,
        dailyRent,
        profit,
        note
      });
    }

    this.saveData();
    this.showToast(`บันทึกยอดเงิน ${this.formatThaiDate(date)} เรียบร้อย!`, 'success');
    this.renderTodaySummary(date);
    this.renderDashboard();
    this.renderCalendar();
  }

  renderTodaySummary(targetDate = null) {
    const selectedDate = targetDate || document.getElementById('selectedTodayDateInput')?.value || this.formatDate(new Date());

    const isSchoolOpen = this.isSchoolOpenDay(selectedDate);
    const isWk = this.isWeekend(selectedDate);
    const isHol = this.isHoliday(selectedDate);

    const subtitle = document.getElementById('todayDateSubtitle');
    const displayThaiLarge = document.getElementById('displayThaiDateLarge');
    const hubStatusTag = document.getElementById('dateHubStatusTag');

    // Update Date Hub Card Display
    if (displayThaiLarge) {
      displayThaiLarge.textContent = this.formatThaiDate(selectedDate);
    }
    if (hubStatusTag) {
      if (isSchoolOpen) {
        hubStatusTag.textContent = 'วันเปิดเรียน';
        hubStatusTag.className = 'figma-capsule-tag open';
      } else if (isHol) {
        hubStatusTag.textContent = this.getHolidayDescription(selectedDate) || 'วันหยุดโรงเรียน';
        hubStatusTag.className = 'figma-capsule-tag holiday';
      } else {
        hubStatusTag.textContent = 'วันเสาร์-อาทิตย์';
        hubStatusTag.className = 'figma-capsule-tag weekend';
      }
    }

    // Toggle active state on jump shortcuts
    const todayStr = this.formatDate(new Date());
    const yDate = new Date();
    yDate.setDate(yDate.getDate() - 1);
    const yStr = this.formatDate(yDate);

    const btnToday = document.getElementById('btnJumpToday');
    const btnYest = document.getElementById('btnJumpYesterday');
    const btnOther = document.getElementById('btnJumpPicker');

    if (btnToday) btnToday.classList.toggle('active', selectedDate === todayStr);
    if (btnYest) btnYest.classList.toggle('active', selectedDate === yStr);
    if (btnOther) btnOther.classList.toggle('active', selectedDate !== todayStr && selectedDate !== yStr);

    if (subtitle) {
      if (isSchoolOpen) {
        const ym = selectedDate.substring(0, 7);
        const openDays = this.getSchoolOpenDaysCount(ym);
        subtitle.textContent = `ยอดขายประจำวัน ${this.formatThaiDate(selectedDate)} (วันเปิดเรียน) หักต้นทุนวัตถุดิบ + ค่าเช่าร้านเฉลี่ย ฿${this.getDailyRentForSchoolDay(selectedDate)}/วัน (เดือนนี้เปิดจริง ${openDays} วัน)`;
      } else if (isHol) {
        subtitle.textContent = `ยอดขายประจำวัน ${this.formatThaiDate(selectedDate)} (${this.getHolidayDescription(selectedDate) || 'วันหยุดโรงเรียน'}) หักเฉพาะต้นทุนวัตถุดิบ (ไม่คิดค่าเช่าร้าน)`;
      } else {
        subtitle.textContent = `ยอดขายประจำวัน ${this.formatThaiDate(selectedDate)} (วันหยุดเสาร์-อาทิตย์ โรงเรียนปิด) หักเฉพาะต้นทุนวัตถุดิบ (ไม่คิดค่าเช่าประจำวัน)`;
      }
    }

    const record = this.data.dailySales.find(d => d.date === selectedDate);
    const revenue = record ? record.revenue : 0;
    const cost = record ? record.cost : 0;
    const profit = record ? record.profit : 0;
    const margin = revenue > 0 ? ((profit / revenue) * 100).toFixed(1) : 0;

    const dailyRent = record ? (record.dailyRent !== undefined ? record.dailyRent : (isSchoolOpen ? this.getDailyRentForSchoolDay(selectedDate) : 0)) : (isSchoolOpen ? this.getDailyRentForSchoolDay(selectedDate) : 0);
    const matCost = record ? (record.materialCost !== undefined ? record.materialCost : Math.max(0, cost - dailyRent)) : 0;

    // Update Stat Cards (if present)
    const elSalesAmount = document.getElementById('todaySalesAmount');
    if (elSalesAmount) elSalesAmount.textContent = this.formatCurrency(revenue);

    const elCostAmount = document.getElementById('todayCostAmount');
    if (elCostAmount) elCostAmount.textContent = this.formatCurrency(cost);

    const costSub = document.getElementById('todayCostSubtitle');
    if (costSub) {
      if (isSchoolOpen) {
        costSub.textContent = `วัตถุดิบ ${this.formatCurrency(matCost)} + ค่าเช่าวันเปิดเรียน ฿${dailyRent}/วัน`;
      } else {
        costSub.textContent = `วัตถุดิบ ${this.formatCurrency(matCost)} + วันหยุดโรงเรียน (ค่าเช่า ฿0)`;
      }
    }

    const profitCard = document.getElementById('todayProfitCard');
    const profitLabel = document.getElementById('todayProfitLabel');
    const profitAmount = document.getElementById('todayProfitAmount');
    const profitMargin = document.getElementById('todayProfitMargin');
    const profitIconWrapper = document.getElementById('todayProfitIconWrapper');

    if (profit >= 0) {
      if (profitLabel) profitLabel.textContent = 'กำไรสุทธิวันนี้ (ได้เงินจริง)';
      if (profitAmount) {
        profitAmount.textContent = `+${this.formatCurrency(profit)}`;
        profitAmount.className = 'stat-value text-green';
      }
      if (profitMargin) profitMargin.textContent = `อัตรากำไร ${margin}% (หักต้นทุนแล้ว)`;
      if (profitIconWrapper) profitIconWrapper.className = 'stat-icon-wrapper green';
    } else {
      if (profitLabel) profitLabel.textContent = 'ขาดทุนวันนี้ (ต้นทุนสูงกว่ายอดขาย)';
      const absLoss = Math.abs(profit);
      if (profitAmount) {
        profitAmount.textContent = `-${this.formatCurrency(absLoss)}`;
        profitAmount.className = 'stat-value text-danger';
      }
      if (profitMargin) profitMargin.textContent = `ขาดทุน ${this.formatCurrency(absLoss)} (รายจ่าย/ต้นทุนสูงกว่ายอดขาย)`;
      if (profitIconWrapper) profitIconWrapper.className = 'stat-icon-wrapper red';
    }

    // Sidebar badge for actual today
    const nowStr = this.formatDate(new Date());
    const actualToday = this.data.dailySales.find(d => d.date === nowStr);
    const badge = document.getElementById('todaySalesBadge');
    if (badge) badge.textContent = actualToday ? this.formatCurrency(actualToday.revenue) : '0 บ.';

    // Render Daily Sales History Table
    this.renderDailyHistoryTable();
  }

  renderDailyHistoryTable() {
    const feedWrap = document.getElementById('todaySalesMobileCards');
    const countBadge = document.getElementById('todayBillCountBadge');

    const sortOrder = document.getElementById('dailySalesSortOrder')?.value || 'newest';
    const list = [...this.data.dailySales].sort((a, b) => {
      const dateCmp = (a.date || '').localeCompare(b.date || '');
      const idA = String(a.id || '');
      const idB = String(b.id || '');
      const idCmp = idA.localeCompare(idB);
      if (sortOrder === 'oldest') {
        return dateCmp !== 0 ? dateCmp : idCmp;
      }
      return dateCmp !== 0 ? -dateCmp : -idCmp;
    });

    if (countBadge) countBadge.textContent = `${list.length} วัน`;

    if (list.length === 0) {
      if (feedWrap) {
        feedWrap.innerHTML = `
          <div class="figma-tx-empty">
            <div class="figma-tx-empty-icon">
              <i data-lucide="inbox"></i>
            </div>
            <div class="figma-tx-empty-title">ยังไม่มีรายการบันทึกยอดขาย</div>
            <div class="figma-tx-empty-desc">กรอกยอดขายที่ได้จากแป้นพิมพ์ด้านบนเพื่อเริ่มบันทึก</div>
          </div>
        `;
      }
      this.refreshLucide();
      return;
    }

    // Render Unified Transaction Cards Stream (Modern Feed for both Web & Mobile, No Column Table)
    if (feedWrap) {
      feedWrap.innerHTML = list.map(d => {
        const isProfit = d.profit >= 0;
        const margin = d.revenue > 0 ? ((Math.abs(d.profit) / d.revenue) * 100).toFixed(1) : 0;
        const isSchoolOpen = this.isSchoolOpenDay(d.date);

        return `
          <div class="figma-tx-card ${isProfit ? 'is-profit' : 'is-loss'}">
            <!-- Main Content Row -->
            <div class="figma-tx-main">
              <!-- Left: Avatar Icon + Date & Subtitle -->
              <div class="figma-tx-left">
                <div class="figma-tx-avatar">
                  <i data-lucide="${isProfit ? 'trending-up' : 'trending-down'}"></i>
                </div>
                <div class="figma-tx-meta">
                  <div class="figma-tx-date-row">
                    <span class="figma-tx-date">${this.formatThaiDate(d.date)}</span>
                    <span class="figma-tx-pill ${isSchoolOpen ? 'open' : 'holiday'}">
                      ${isSchoolOpen ? 'วันเปิดเรียน' : 'วันหยุด'}
                    </span>
                  </div>
                  <div class="figma-tx-sub">
                    <span>หักต้นทุน</span>
                    <span class="figma-tx-cost-num">${this.formatCurrency(d.cost)}</span>
                  </div>
                </div>
              </div>

              <!-- Right: Revenue Amount + Profit/Loss Pill -->
              <div class="figma-tx-right">
                <span class="figma-tx-revenue">${this.formatCurrency(d.revenue)}</span>
                <span class="figma-tx-profit-pill ${isProfit ? 'profit' : 'loss'}">
                  ${isProfit ? `+${this.formatCurrency(d.profit)} (+${margin}%)` : `-${this.formatCurrency(Math.abs(d.profit))} (${margin}%)`}
                </span>
              </div>
            </div>

            <!-- Optional Note -->
            ${d.note ? `
              <div class="figma-tx-note-row">
                <i data-lucide="message-square"></i>
                <span>${this.escapeHtml(d.note)}</span>
              </div>
            ` : ''}

            <!-- Touch Actions -->
            <div class="figma-tx-actions">
              <button type="button" class="btn-figma-tx-action edit" onclick="app.editDailyRecord('${d.date}')">
                <i data-lucide="edit-3"></i>
                <span>แก้ไขยอดขาย</span>
              </button>
              <button type="button" class="btn-figma-tx-action delete" onclick="app.deleteDailyRecord('${d.id}')">
                <i data-lucide="trash-2"></i>
                <span>ลบ</span>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    this.refreshLucide();
  }

  editDailyRecord(dateStr) {
    const todayInput = document.getElementById('selectedTodayDateInput');
    const dailyFormDate = document.getElementById('dailyFormDate');
    if (todayInput) todayInput.value = dateStr;
    if (dailyFormDate) dailyFormDate.value = dateStr;

    this.loadDailyFormForDate(dateStr);
    this.renderTodaySummary(dateStr);

    // Smooth scroll to form
    document.querySelector('.daily-entry-card')?.scrollIntoView({ behavior: 'smooth' });
    document.getElementById('dailyFormRevenue')?.focus();
  }

  deleteDailyRecord(id) {
    if (confirm('คุณต้องการลบรายการยอดขายของวันนี้ใช่หรือไม่?')) {
      this.data.dailySales = this.data.dailySales.filter(d => d.id !== id);
      this.saveData();
      this.showToast('ลบรายการยอดขายแล้ว', 'info');
      this.renderTodaySummary();
      this.renderDashboard();
      this.renderCalendar();
    }
  }

  // -------------------------------------------------------------------------
  // TAB 3: EXPENSES & INGREDIENT COSTS
  // -------------------------------------------------------------------------
  renderExpenses() {
    const filter = document.getElementById('expenseCategoryFilter').value;
    let list = [...this.data.expenses];

    if (filter !== 'ALL') {
      list = list.filter(e => e.category === filter);
    }

    const totalAllExpenses = this.data.expenses.reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catIngredients = this.data.expenses.filter(e => e.category === 'INGREDIENT').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catPackaging = this.data.expenses.filter(e => e.category === 'PACKAGING').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catStock = this.data.expenses.filter(e => e.category === 'STOCK').reduce((a, b) => a + (Number(b.amount) || 0), 0);

    const totalEl = document.getElementById('expCategoryTotal');
    if (totalEl) totalEl.textContent = this.formatCurrency(totalAllExpenses);
    const countSubtextEl = document.getElementById('expTotalCountSubtext');
    if (countSubtextEl) countSubtextEl.textContent = `${this.data.expenses.length} รายการค่าใช้จ่าย`;

    document.getElementById('expCategoryIngredients').textContent = this.formatCurrency(catIngredients);
    document.getElementById('expCategoryPackaging').textContent = this.formatCurrency(catPackaging);
    document.getElementById('expCategoryStock').textContent = this.formatCurrency(catStock);

    const tbody = document.getElementById('expenseTableBody');
    const feedWrap = document.getElementById('expenseCardsFeed');
    const countBadge = document.getElementById('expenseFilteredCountBadge');

    if (countBadge) countBadge.textContent = `${list.length} รายการ`;

    if (list.length === 0) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">ไม่มีรายการค่าใช้จ่ายในหมวดหมู่นี้</td></tr>`;
      if (feedWrap) {
        feedWrap.innerHTML = `
          <div class="figma-tx-empty">
            <div class="figma-tx-empty-icon">
              <i data-lucide="inbox"></i>
            </div>
            <div class="figma-tx-empty-title">ไม่มีรายการค่าใช้จ่ายในหมวดหมู่นี้</div>
            <div class="figma-tx-empty-desc">กดปุ่ม "+ เพิ่มค่าใช้จ่าย" ด้านบนเพื่อเริ่มบันทึกบิลซื้อของ</div>
          </div>
        `;
      }
      this.refreshLucide();
      return;
    }

    const sortOrder = document.getElementById('expenseSortOrder')?.value || 'newest';
    const sorted = [...list].sort((a, b) => {
      // เปรียบเทียบตามวันที่ และ id (timestamp)
      const dateCmp = (a.date || '').localeCompare(b.date || '');
      const idA = String(a.id || '');
      const idB = String(b.id || '');
      const idCmp = idA.localeCompare(idB);
      if (sortOrder === 'oldest') {
        return dateCmp !== 0 ? dateCmp : idCmp;
      }
      // default: newest
      return dateCmp !== 0 ? -dateCmp : -idCmp;
    });

    // Render Unified Cards Feed (Matching Figma Mobile Design System)
    if (feedWrap) {
      feedWrap.innerHTML = sorted.map(exp => {
        let badgeClass = 'ingredient';
        let catName = 'วัตถุดิบชงน้ำ';
        let avatarClass = 'cat-ingredient';
        let iconName = 'shopping-cart';

        if (exp.category === 'INGREDIENT') {
          badgeClass = 'ingredient';
          catName = 'วัตถุดิบชงน้ำ';
          avatarClass = 'cat-ingredient';
          iconName = 'shopping-cart';
        } else if (exp.category === 'PACKAGING') {
          badgeClass = 'packaging';
          catName = 'บรรจุภัณฑ์/แก้ว';
          avatarClass = 'cat-packaging';
          iconName = 'box';
        } else if (exp.category === 'STOCK') {
          badgeClass = 'stock';
          catName = 'ซื้อยกลัง/สำเร็จรูป';
          avatarClass = 'cat-stock';
          iconName = 'archive';
        } else if (exp.category === 'OTHER') {
          badgeClass = 'other';
          catName = 'อื่นๆ / น้ำแข็ง';
          avatarClass = 'cat-other';
          iconName = 'more-horizontal';
        }

        const pSize = Number(exp.packSize) || 0;
        const pUnit = exp.packUnit || '';
        let unitPriceStr = '';
        if (pSize > 0 && exp.amount > 0) {
          const uCost = exp.amount / pSize;
          unitPriceStr = uCost < 1 ? `(฿${uCost.toFixed(2)}/${pUnit})` : `(฿${uCost.toFixed(1)}/${pUnit})`;
        }
        const qtyDisplay = exp.qtyDesc || (pSize > 0 ? `${pSize} ${pUnit}` : '');

        // ค้นหาข้อมูลสต๊อกคงเหลือปัจจุบันที่เชื่อมโยงกับรายการนี้
        const expTitleClean = String(exp.title || '').split('(')[0].trim().toLowerCase();
        const matchedStock = (this.data.stockItems || []).find(s => {
          if (!s || !s.name) return false;
          if (exp.stockItemId && String(s.id) === String(exp.stockItemId)) return true;
          const sClean = String(s.name).split('(')[0].trim().toLowerCase();
          const sNameLower = String(s.name).toLowerCase();
          const expTitleLower = String(exp.title || '').toLowerCase();
          return sNameLower === expTitleLower || sClean === expTitleClean;
        });

        let stockBalanceBadge = '';
        if (matchedStock) {
          const curQty = Number(matchedStock.qty) || 0;
          const minQ = Number(matchedStock.minQty) || 0;
          const stockUnit = matchedStock.unit || pUnit || 'หน่วย';
          const isLow = minQ > 0 && curQty <= minQ;
          const badgeClass = isLow ? 'stock-badge-low' : 'stock-badge-normal';
          const badgeIcon = isLow ? '⚠️' : '📊';
          const badgeStyle = isLow 
            ? 'background:#fef2f2; color:#dc2626; border:1px solid #fecaca; font-weight:700; border-radius:9999px; padding:0.15rem 0.5rem; font-size:0.75rem; display:inline-flex; align-items:center; gap:0.25rem;'
            : 'background:#f0fdf4; color:#16a34a; border:1px solid #bbf7d0; font-weight:700; border-radius:9999px; padding:0.15rem 0.5rem; font-size:0.75rem; display:inline-flex; align-items:center; gap:0.25rem;';
          stockBalanceBadge = `<span style="${badgeStyle}" title="ปริมาณคงเหลือในสต๊อกปัจจุบัน">${badgeIcon} คงเหลือในสต๊อก: <strong>${curQty} ${this.escapeHtml(stockUnit)}</strong></span>`;
        }

        return `
          <div class="figma-exp-card">
            <!-- Top Row: Icon + Title/Meta + Amount -->
            <div class="fec-top-row">
              <div class="fec-left">
                <div class="fec-avatar ${avatarClass}">
                  <i data-lucide="${iconName}"></i>
                </div>
                <div class="fec-title-wrap">
                  <div class="fec-title" title="${this.escapeHtml(exp.title)}">${this.escapeHtml(exp.title)}</div>
                  <div class="fec-meta-row">
                    <span class="fec-date">${this.formatThaiDate(exp.date)}</span>
                    <span class="fec-badge ${badgeClass}">${catName}</span>
                  </div>
                </div>
              </div>
              <div class="fec-right">
                <span class="fec-amount">-${this.formatCurrency(exp.amount)}</span>
                ${unitPriceStr ? `<span class="fec-unit-cost">${unitPriceStr}</span>` : ''}
              </div>
            </div>

            <!-- Sub Row: Pack Quantity, Stock Balance & Note if present -->
            ${qtyDisplay || exp.note || stockBalanceBadge ? `
              <div class="fec-sub-row" style="display:flex; flex-wrap:wrap; gap:0.4rem; align-items:center;">
                <div class="fec-pack-info" style="display:inline-flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
                  ${qtyDisplay ? `<span>📦 บันทึกรับ: ${this.escapeHtml(qtyDisplay)}</span>` : ''}
                  ${stockBalanceBadge}
                </div>
                ${exp.note ? `<div class="fec-note" style="margin-left:auto;" title="${this.escapeHtml(exp.note)}">📝 ${this.escapeHtml(exp.note)}</div>` : ''}
              </div>
            ` : ''}

            <!-- Action Buttons -->
            <div class="fec-actions">
              <button type="button" class="btn-figma-tx-action edit" onclick="app.openExpenseModal('${exp.id}')">
                <i data-lucide="edit-3"></i>
                <span>แก้ไข</span>
              </button>
              <button type="button" class="btn-figma-tx-action delete" onclick="app.deleteExpense('${exp.id}')">
                <i data-lucide="trash-2"></i>
                <span>ลบ</span>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    if (tbody) {
      tbody.innerHTML = '';
    }

    this.refreshLucide();
  }

  setExpenseCategory(cat) {
    const filterInput = document.getElementById('expenseCategoryFilter');
    if (filterInput) filterInput.value = cat;

    document.querySelectorAll('.figma-pill-filter').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.cat === cat);
    });

    this.renderExpenses();
  }

  deleteExpense(expId) {
    if (confirm('คุณต้องการลบรายการค่าใช้จ่ายนี้ใช่หรือไม่?')) {
      const exp = (this.data.expenses || []).find(e => e.id === expId);
      if (exp) {
        this.removeExpenseFromStock(exp);
      }
      this.data.expenses = (this.data.expenses || []).filter(e => e.id !== expId);
      this.saveData();
      this.syncRecipesWithExpenses();
      this.showToast('ลบรายการค่าใช้จ่ายเรียบร้อย', 'info');
      this.renderExpenses();
      this.renderRecipes();
      this.renderStock();
      this.renderLowStockAlertView();
      this.renderDashboard();
    }
  }

  // -------------------------------------------------------------------------
  // TAB 4: PRICING CALCULATOR (น้ำแยกขวด / ลัง)
  // -------------------------------------------------------------------------
  bindPricingCalc() {
    const packPriceInput = document.getElementById('calcPackPrice');
    const unitsInput = document.getElementById('calcUnitsPerPack');
    const extraInput = document.getElementById('calcExtraCostPerUnit');
    const marginSlider = document.getElementById('calcMarginSlider');
    const marginInput = document.getElementById('calcDesiredMargin');
    const profitBahtInput = document.getElementById('calcDesiredProfitBaht');

    const updateCalc = () => this.calculatePricing();

    if (packPriceInput) packPriceInput.addEventListener('input', updateCalc);
    if (unitsInput) unitsInput.addEventListener('input', updateCalc);
    if (extraInput) extraInput.addEventListener('input', updateCalc);
    if (profitBahtInput) profitBahtInput.addEventListener('input', updateCalc);

    if (marginSlider && marginInput) {
      marginSlider.addEventListener('input', () => {
        marginInput.value = marginSlider.value;
        updateCalc();
      });
      marginInput.addEventListener('input', () => {
        marginSlider.value = marginInput.value;
        updateCalc();
      });
    }

    document.querySelectorAll('input[name="profitBahtScope"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const scope = e.target.value;
        const affix = document.getElementById('affixProfitScope');
        const hint = document.getElementById('hintProfitScope');

        if (scope === 'pack') {
          if (affix) affix.textContent = 'บาท / ลัง';
          if (hint) hint.textContent = 'ระบุกำไรที่ต้องการรวมต่อ 1 ลัง → ระบบจะเฉลี่ยกำไรต่อขวดและคำนวณราคาขายให้ทันที';
        } else {
          if (affix) affix.textContent = 'บาท / ขวด';
          if (hint) hint.textContent = 'ระบุกำไรที่ต้องการต่อ 1 ขวด → ระบบจะคำนวณราคาขายต่อขวดให้ทันที';
        }
        updateCalc();
      });
    });

    document.querySelectorAll('input[name="calcMode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const val = e.target.value;
        const profitBahtBox = document.getElementById('calcModeProfitBahtBox');
        const marginBox = document.getElementById('calcModeMarginBox');
        const tabProfitBaht = document.getElementById('tabModeProfitBaht');
        const tabMargin = document.getElementById('tabModeMargin');

        if (val === 'profitBaht') {
          if (profitBahtBox) profitBahtBox.style.display = 'block';
          if (marginBox) marginBox.style.display = 'none';
          if (tabProfitBaht) tabProfitBaht.classList.add('active');
          if (tabMargin) tabMargin.classList.remove('active');
        } else {
          if (profitBahtBox) profitBahtBox.style.display = 'none';
          if (marginBox) marginBox.style.display = 'block';
          if (tabProfitBaht) tabProfitBaht.classList.remove('active');
          if (tabMargin) tabMargin.classList.add('active');
        }
        updateCalc();
      });
    });

    const btnSaveCalcPreset = document.getElementById('btnSaveCalcPreset');
    if (btnSaveCalcPreset) {
      btnSaveCalcPreset.addEventListener('click', () => {
        const name = document.getElementById('calcItemName')?.value.trim() || 'น้ำขวดสำเร็จรูป';
        const packPrice = parseFloat(document.getElementById('calcPackPrice')?.value) || 0;
        const unitsPerPack = parseInt(document.getElementById('calcUnitsPerPack')?.value) || 1;
        const extraCost = parseFloat(document.getElementById('calcExtraCostPerUnit')?.value) || 0;

        const rawCostPerUnit = unitsPerPack > 0 ? (packPrice / unitsPerPack) : 0;
        const totalCostPerUnit = rawCostPerUnit + extraCost;

        const price = parseFloat(document.getElementById('resSellingPrice')?.textContent.replace(/[^0-9.]/g, '')) || 0;
        const profitPerUnit = price - totalCostPerUnit;
        const packProfit = profitPerUnit * unitsPerPack;

        if (!Array.isArray(this.data.savedProducts)) {
          this.data.savedProducts = [];
        }

        const newProduct = {
          id: 'sp_' + Date.now(),
          name: name,
          packPrice: packPrice,
          unitsPerPack: unitsPerPack,
          extraCost: extraCost,
          unitCost: totalCostPerUnit,
          sellingPrice: price,
          unitProfit: profitPerUnit,
          packProfit: packProfit,
          savedAt: this.formatDate(new Date())
        };

        this.data.savedProducts.unshift(newProduct);
        this.saveData();
        this.renderSavedProducts();
        this.showToast(`บันทึกราคา '${name}' เข้าตารางเมนูขายเรียบร้อย!`, 'success');

        // Scroll to table smoothly
        const tableElem = document.getElementById('savedProductsSection');
        if (tableElem) {
          tableElem.scrollIntoView({ behavior: 'smooth' });
        }
      });
    }
  }

  calculatePricing() {
    const packPriceRaw = document.getElementById('calcPackPrice')?.value;
    const unitsPerPackRaw = document.getElementById('calcUnitsPerPack')?.value;
    const extraCostRaw = document.getElementById('calcExtraCostPerUnit')?.value;

    const packPrice = parseFloat(packPriceRaw) || 0;
    // If packPrice is provided but units is left empty, default to 24 (the standard pack size shown in placeholder)
    let unitsPerPack = parseInt(unitsPerPackRaw);
    if (isNaN(unitsPerPack) || unitsPerPack <= 0) {
      unitsPerPack = packPrice > 0 ? 24 : 0;
    }
    const extraCost = parseFloat(extraCostRaw) || 0;

    const rawCostPerUnit = unitsPerPack > 0 ? (packPrice / unitsPerPack) : 0;
    const totalCostPerUnit = rawCostPerUnit + extraCost;

    const mode = document.querySelector('input[name="calcMode"]:checked')?.value || 'profitBaht';

    let sellingPrice = 0;
    let profitPerUnit = 0;
    let marginPercent = 0;

    if (mode === 'profitBaht') {
      const scope = document.querySelector('input[name="profitBahtScope"]:checked')?.value || 'unit';
      const desiredProfitVal = parseFloat(document.getElementById('calcDesiredProfitBaht')?.value) || 0;

      if (scope === 'pack') {
        profitPerUnit = (unitsPerPack > 0) ? (desiredProfitVal / unitsPerPack) : desiredProfitVal;
      } else {
        profitPerUnit = desiredProfitVal;
      }

      sellingPrice = (totalCostPerUnit > 0 || profitPerUnit > 0) ? (totalCostPerUnit + profitPerUnit) : 0;
      marginPercent = sellingPrice > 0 ? ((profitPerUnit / sellingPrice) * 100) : 0;
    } else {
      const desiredMargin = parseFloat(document.getElementById('calcDesiredMargin')?.value) || 0;
      sellingPrice = totalCostPerUnit > 0 ? Math.ceil(totalCostPerUnit * (1 + desiredMargin / 100)) : 0;
      profitPerUnit = sellingPrice - totalCostPerUnit;
      marginPercent = sellingPrice > 0 ? ((profitPerUnit / sellingPrice) * 100) : 0;
    }

    const totalPackProfit = profitPerUnit * (unitsPerPack || 1);

    const resSellingPrice = document.getElementById('resSellingPrice');
    const resProfitTag = document.getElementById('resProfitPerUnitTag');
    const resRawCost = document.getElementById('resRawCostPerUnit');
    const resExtraCost = document.getElementById('resExtraCostPerUnit');
    const resTotalCost = document.getElementById('resTotalCostPerUnit');
    const resProfit = document.getElementById('resProfitPerUnit');
    const resMargin = document.getElementById('resMarginPercent');
    const resTotalPackProfit = document.getElementById('resTotalPackProfit');

    if (resSellingPrice) resSellingPrice.textContent = this.formatCurrency(sellingPrice);
    if (resProfitTag) {
      if (profitPerUnit >= 0) {
        resProfitTag.textContent = `กำไรขวดละ +${this.formatCurrency(profitPerUnit)}`;
        resProfitTag.style.color = '#34d399';
      } else {
        resProfitTag.textContent = `ขาดทุนขวดละ ${this.formatCurrency(profitPerUnit)}`;
        resProfitTag.style.color = '#f87171';
      }
    }

    if (resRawCost) resRawCost.textContent = `฿${rawCostPerUnit.toFixed(2)}`;
    if (resExtraCost) resExtraCost.textContent = `฿${extraCost.toFixed(2)}`;
    if (resTotalCost) resTotalCost.textContent = `฿${totalCostPerUnit.toFixed(2)}`;
    if (resProfit) resProfit.textContent = `฿${profitPerUnit.toFixed(2)}`;
    if (resMargin) resMargin.textContent = `${marginPercent.toFixed(1)}%`;
    if (resTotalPackProfit) resTotalPackProfit.textContent = `฿${totalPackProfit.toFixed(2)}`;

    // Update Live Formula Equation Banner
    const resFormulaCost = document.getElementById('resFormulaCost');
    const resFormulaProfit = document.getElementById('resFormulaProfit');
    const resFormulaSell = document.getElementById('resFormulaSell');
    if (resFormulaCost) resFormulaCost.textContent = `฿${totalCostPerUnit.toFixed(2)}`;
    if (resFormulaProfit) resFormulaProfit.textContent = `฿${profitPerUnit.toFixed(2)}`;
    if (resFormulaSell) resFormulaSell.textContent = `฿${sellingPrice.toFixed(2)}`;

    this.renderPriceTiers(totalCostPerUnit, unitsPerPack || 1, sellingPrice);
  }

  renderPriceTiers(costPerUnit, unitsPerPack, currentSelectedPrice) {
    const grid = document.getElementById('pricingTiersGrid');
    if (!grid) return;

    if (costPerUnit <= 0) {
      grid.innerHTML = '<div class="text-muted text-sm p-3 w-full text-center" style="grid-column: 1 / -1;">กรอกข้อมูลราคาต่อลังและจำนวนขวดเพื่อแสดงตัวเลือกราคาแนะนำ</div>';
      return;
    }

    let tiers = [20, 25, 30];
    if (costPerUnit > 20) {
      tiers = [Math.ceil(costPerUnit + 5), Math.ceil(costPerUnit + 10), Math.ceil(costPerUnit + 15)];
    }

    grid.innerHTML = tiers.map(tPrice => {
      const p = tPrice - costPerUnit;
      const packP = p * unitsPerPack;
      const isSel = Math.round(currentSelectedPrice) === tPrice;

      return `
        <div class="tier-card ${isSel ? 'selected' : ''}" onclick="app.selectTierPrice(${tPrice})">
          <div class="text-muted text-sm">ตั้งราคาขาย</div>
          <div class="tier-price">฿${tPrice}</div>
          <div class="tier-profit font-semibold ${p >= 0 ? 'text-green' : 'text-danger'}">
            ${p >= 0 ? `+฿${p.toFixed(2)}/ขวด` : `-฿${Math.abs(p).toFixed(2)}`}
          </div>
          <div class="text-muted" style="font-size: 0.7rem; margin-top: 0.2rem;">
            (กำไร ฿${packP.toFixed(0)}/ลัง)
          </div>
        </div>
      `;
    }).join('');
  }

  selectTierPrice(price) {
    const profitRadio = document.querySelector('input[name="calcMode"][value="profitBaht"]');
    if (profitRadio) profitRadio.checked = true;
    const profitBahtBox = document.getElementById('calcModeProfitBahtBox');
    const marginBox = document.getElementById('calcModeMarginBox');
    if (profitBahtBox) profitBahtBox.style.display = 'block';
    if (marginBox) marginBox.style.display = 'none';
    const tabProfitBaht = document.getElementById('tabModeProfitBaht');
    const tabMargin = document.getElementById('tabModeMargin');
    if (tabProfitBaht) tabProfitBaht.classList.add('active');
    if (tabMargin) tabMargin.classList.remove('active');

    // Calculate profit in Baht for this target selling price
    const packPrice = parseFloat(document.getElementById('calcPackPrice')?.value) || 0;
    const unitsPerPack = parseInt(document.getElementById('calcUnitsPerPack')?.value) || 1;
    const extraCost = parseFloat(document.getElementById('calcExtraCostPerUnit')?.value) || 0;
    const totalCostPerUnit = (unitsPerPack > 0 ? (packPrice / unitsPerPack) : 0) + extraCost;
    const profitUnit = Math.max(0, parseFloat((price - totalCostPerUnit).toFixed(2)));

    const scopeRadio = document.querySelector('input[name="profitBahtScope"]:checked')?.value || 'unit';
    const profitInput = document.getElementById('calcDesiredProfitBaht');
    if (profitInput) {
      if (scopeRadio === 'pack') {
        profitInput.value = (profitUnit * unitsPerPack).toFixed(1);
      } else {
        profitInput.value = profitUnit;
      }
    }
    this.calculatePricing();
  }

  renderSavedProducts() {
    const tbody = document.getElementById('savedProductsTableBody');
    const cardsFeed = document.getElementById('savedProductsCardsFeed');
    const badge = document.getElementById('savedProductsCountBadge');

    const list = this.data.savedProducts || [];
    if (badge) badge.textContent = `${list.length} รายการ`;

    // 1. Render Mobile & Desktop Unified Cards Feed
    if (cardsFeed) {
      if (list.length === 0) {
        cardsFeed.innerHTML = `
          <div class="figma-tx-empty">
            <div class="figma-empty-icon"><i data-lucide="bookmark-x"></i></div>
            <div class="figma-empty-text">ยังไม่มีสินค้าที่บันทึกไว้</div>
            <div class="figma-empty-sub">ลองใช้เครื่องคิดเลขด้านบนแล้วกดปุ่ม "บันทึกราคานี้เข้าเมนูขาย"</div>
          </div>
        `;
      } else {
        cardsFeed.innerHTML = list.map(item => {
          const isProfit = (item.unitProfit || 0) >= 0;
          const profitUnitStr = isProfit
            ? `+฿${Number(item.unitProfit || 0).toFixed(2)}`
            : `-฿${Math.abs(Number(item.unitProfit || 0)).toFixed(2)}`;
          const packProfitStr = isProfit
            ? `+฿${Number(item.packProfit || 0).toFixed(0)}`
            : `-฿${Math.abs(Number(item.packProfit || 0)).toFixed(0)}`;

          return `
            <div class="figma-prod-card" data-id="${item.id}">
              <div class="fpc-top">
                <div class="fpc-left">
                  <div class="fpc-avatar">
                    <i data-lucide="milk"></i>
                  </div>
                  <div class="fpc-name-wrap">
                    <span class="fpc-name">${this.escapeHtml(item.name || 'น้ำดื่ม/สินค้า')}</span>
                    <span class="fpc-pack-desc">
                      ซื้อลังละ ฿${Number(item.packPrice || 0).toLocaleString()} (${item.unitsPerPack || 0} ขวด)
                    </span>
                  </div>
                </div>
                <div class="fpc-right">
                  <span class="fpc-price">฿${Number(item.sellingPrice || 0).toFixed(2)}</span>
                  <span class="fpc-profit-pill ${isProfit ? 'profit' : 'loss'}">
                    ${profitUnitStr}/ขวด
                  </span>
                </div>
              </div>

              <!-- Secondary Row: Breakdown -->
              <div class="fpc-meta-strip">
                <span class="fpc-cost">
                  ต้นทุนรวม: <strong>฿${Number(item.unitCost || 0).toFixed(2)}</strong>/ขวด
                  ${item.extraCost > 0 ? `<small class="text-muted">(+เสริม ฿${item.extraCost})</small>` : ''}
                </span>
                <span class="fpc-pack-profit ${isProfit ? 'text-green' : 'text-danger'}">
                  กำไร <strong>${packProfitStr}</strong>/ลัง
                </span>
              </div>

              <!-- Action Buttons -->
              <div class="fpc-actions">
                <button class="btn-figma-tx-action" data-action="load" data-id="${item.id}" title="ดึงกลับมาคำนวณใหม่">
                  <i data-lucide="calculator"></i>
                  <span>ดึงมาคำนวณ</span>
                </button>
                <button class="btn-figma-tx-action danger" data-action="delete" data-id="${item.id}" title="ลบรายการ">
                  <i data-lucide="trash-2"></i>
                  <span>ลบ</span>
                </button>
              </div>
            </div>
          `;
        }).join('');
      }

      if (!cardsFeed._eventsBound) {
        cardsFeed._eventsBound = true;
        cardsFeed.addEventListener('click', (e) => {
          const btn = e.target.closest('button[data-action]');
          if (!btn) return;
          const action = btn.getAttribute('data-action');
          const id = btn.getAttribute('data-id');
          if (action === 'delete') {
            this.deleteSavedProduct(id);
          } else if (action === 'load') {
            this.loadProductToCalculator(id);
          }
        });
      }
    }

    // 2. Fallback Table (if table exists)
    if (tbody) {
      if (list.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="7" class="text-center py-4 text-muted">
              ยังไม่มีสินค้าที่บันทึกไว้ ลองใช้เครื่องคิดเลขด้านบนแล้วกดปุ่ม "บันทึกราคานี้เข้าเมนูขาย"
            </td>
          </tr>
        `;
      } else {
        tbody.innerHTML = list.map(item => {
          const isProfit = (item.unitProfit || 0) >= 0;
          return `
            <tr>
              <td>
                <div class="font-bold text-dark">${this.escapeHtml(item.name)}</div>
                <div class="text-muted text-sm">บันทึกเมื่อ ${this.formatThaiDate(item.savedAt || '2026-10-15')}</div>
              </td>
              <td>
                <span class="font-semibold">฿${Number(item.packPrice || 0).toLocaleString()}</span>
                <span class="text-muted text-sm"> / ${item.unitsPerPack || 0} หน่วย</span>
              </td>
              <td>
                <span class="text-amber font-semibold">฿${Number(item.unitCost || 0).toFixed(2)}</span>
                ${item.extraCost > 0 ? `<span class="text-muted text-xs block">(+ค่าเสริม ฿${item.extraCost})</span>` : ''}
              </td>
              <td>
                <span class="font-bold text-primary">฿${Number(item.sellingPrice || 0).toFixed(2)}</span>
              </td>
              <td>
                <span class="font-semibold ${isProfit ? 'text-green' : 'text-danger'}">
                  ${isProfit ? `+฿${Number(item.unitProfit || 0).toFixed(2)}` : `-฿${Math.abs(Number(item.unitProfit || 0)).toFixed(2)}`}
                </span>
              </td>
              <td>
                <span class="font-bold ${isProfit ? 'text-green' : 'text-danger'}">
                  ${isProfit ? `+฿${Number(item.packProfit || 0).toFixed(2)}` : `-฿${Math.abs(Number(item.packProfit || 0)).toFixed(2)}`}
                </span>
              </td>
              <td class="text-right">
                <button class="icon-btn-border btn-load-calc" data-action="load" data-id="${item.id}" title="ดึงข้อมูลกลับมาคำนวณใหม่">
                  <i data-lucide="calculator" style="width:14px;height:14px;pointer-events:none;"></i>
                </button>
                <button class="icon-btn-border btn-del-calc" data-action="delete" data-id="${item.id}" title="ลบออกจากรายการ">
                  <i data-lucide="trash-2" style="width:14px;height:14px;color:#ef4444;pointer-events:none;"></i>
                </button>
              </td>
            </tr>
          `;
        }).join('');
      }

      // Bind event delegation on tbody (runs once or safely replaced)
      if (!tbody._eventsBound) {
        tbody._eventsBound = true;
        tbody.addEventListener('click', (e) => {
          const btn = e.target.closest('button[data-action]');
          if (!btn) return;
          const action = btn.getAttribute('data-action');
          const id = btn.getAttribute('data-id');
          if (action === 'delete') {
            this.deleteSavedProduct(id);
          } else if (action === 'load') {
            this.loadProductToCalculator(id);
          }
        });
      }
    }

    this.refreshLucide();
  }

  loadProductToCalculator(id) {
    const item = (this.data.savedProducts || []).find(p => p.id === id);
    if (!item) return;

    const nameInput = document.getElementById('calcItemName');
    const packPriceInput = document.getElementById('calcPackPrice');
    const unitsInput = document.getElementById('calcUnitsPerPack');
    const extraInput = document.getElementById('calcExtraCostPerUnit');

    if (nameInput) nameInput.value = item.name;
    if (packPriceInput) packPriceInput.value = item.packPrice;
    if (unitsInput) unitsInput.value = item.unitsPerPack;
    if (extraInput) extraInput.value = item.extraCost || 0;

    this.selectTierPrice(item.sellingPrice);
    this.showToast(`ดึงข้อมูล '${item.name}' ขึ้นเครื่องคิดเลขแล้ว`, 'info');

    // Scroll to calculator top
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  deleteSavedProduct(id) {
    if (confirm('คุณต้องการลบรายการสินค้านี้ออกจากเมนูขายใช่หรือไม่?')) {
      this.data.savedProducts = (this.data.savedProducts || []).filter(p => p.id !== id);
      this.saveData();
      this.renderSavedProducts();
      this.showToast('ลบรายการสินค้าเรียบร้อยแล้ว', 'info');
    }
  }

  // -------------------------------------------------------------------------
  // TAB 5: CALENDAR
  // -------------------------------------------------------------------------
  changeCalendarMonth(offset) {
    this.currentCalendarDate.setMonth(this.currentCalendarDate.getMonth() + offset);
    this.renderCalendar();
  }

  renderCalendar() {
    const calYear = this.currentCalendarDate.getFullYear();
    const calMonth = this.currentCalendarDate.getMonth();

    const label = document.getElementById('calCurrentMonthLabel');
    if (label) {
      label.textContent = this.formatThaiMonthYear(calYear, calMonth);
    }

    const firstDayIndex = new Date(calYear, calMonth, 1).getDay();
    const daysInCurrentMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(calYear, calMonth, 0).getDate();

    const todayStr = this.formatDate(new Date());
    const grid = document.getElementById('calendarDaysGrid');
    if (!grid) return;

    let cellsHtml = '';

    for (let i = firstDayIndex - 1; i >= 0; i--) {
      const dayNum = daysInPrevMonth - i;
      cellsHtml += `
        <div class="cal-day-cell inactive">
          <div class="cal-day-top"><span class="cal-day-number text-muted">${dayNum}</span></div>
        </div>
      `;
    }

    for (let day = 1; day <= daysInCurrentMonth; day++) {
      const dayDateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isToday = dayDateStr === todayStr;
      const isSelected = dayDateStr === this.selectedCalendarDayStr;
      const isWk = this.isWeekend(dayDateStr);
      const isPublicHol = this.isPublicHoliday(dayDateStr);
      const customHol = this.getCustomHoliday(dayDateStr);
      const isHol = isPublicHol || !!customHol;

      const record = this.data.dailySales.find(d => d.date === dayDateStr);

      let dayTypeBadge = '';
      if (customHol) {
        dayTypeBadge = `<span class="cal-custom-holiday-badge" title="${this.escapeHtml(customHol.reason || 'วันหยุดพิเศษ')}">หยุดพิเศษ</span>`;
      } else if (isPublicHol) {
        dayTypeBadge = '<span class="cal-holiday-badge" title="วันหยุดนักขัตฤกษ์">วันหยุด</span>';
      } else if (isWk) {
        dayTypeBadge = '<span class="cal-weekend-badge" title="วันหยุดเสาร์-อาทิตย์">ส-อา</span>';
      }

      cellsHtml += `
        <div class="cal-day-cell ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${isWk ? 'weekend-day' : ''} ${isPublicHol ? 'holiday-day' : ''} ${customHol ? 'custom-holiday-day' : ''}" onclick="app.selectCalendarDay('${dayDateStr}')">
          <div class="cal-day-top">
            <span class="cal-day-number">${day}</span>
            ${dayTypeBadge}
            ${isToday ? '<span class="cal-today-badge">วันนี้</span>' : ''}
          </div>
          <div class="cal-day-metrics">
            ${record ? `
              <span class="cal-cost-tag">ทุน ฿${record.cost.toLocaleString()}</span>
              <span class="${record.profit >= 0 ? 'cal-profit-tag' : 'text-danger'}" style="font-weight: 600;">
                ${record.profit >= 0 ? `+฿${record.profit.toLocaleString()}` : `-฿${Math.abs(record.profit).toLocaleString()}`}
              </span>
            ` : (isWk || isHol ? `<span class="text-muted" style="font-size:0.65rem; color:${customHol ? '#ea580c' : '#94a3b8'};">${customHol ? 'หยุดพิเศษ' : 'หยุด'}</span>` : '<span class="text-muted" style="font-size:0.65rem;">-</span>')}
          </div>
        </div>
      `;
    }

    grid.innerHTML = cellsHtml;
    this.renderCalendarDayDetails(this.selectedCalendarDayStr);
  }

  selectCalendarDay(dateStr) {
    this.selectedCalendarDayStr = dateStr;
    this.renderCalendar();
  }

  renderCalendarDayDetails(dateStr) {
    const title = document.getElementById('selectedDayTitle');
    if (title) title.textContent = `ยอดขายวันที่ ${this.formatThaiDate(dateStr)}`;

    const record = this.data.dailySales.find(d => d.date === dateStr);
    const profit = record ? record.profit : 0;
    const isProfit = profit >= 0;

    document.getElementById('calDaySales').textContent = record ? this.formatCurrency(record.revenue) : '฿0';
    document.getElementById('calDayCost').textContent = record ? this.formatCurrency(record.cost) : '฿0';

    const profitElem = document.getElementById('calDayProfit');
    if (profitElem) {
      profitElem.textContent = record ? (isProfit ? `+${this.formatCurrency(profit)}` : `-${this.formatCurrency(Math.abs(profit))}`) : '฿0';
      profitElem.className = `day-stat-num ${isProfit ? 'text-green' : 'text-danger'}`;
    }

    // Holiday Status and Button Controls in Details Panel
    const statusBadge = document.getElementById('calDayStatusBadge');
    const reasonNote = document.getElementById('calHolidayReasonNote');
    const toggleBtn = document.getElementById('btnToggleDayHoliday');
    const toggleText = document.getElementById('btnToggleHolidayText');

    const isWk = this.isWeekend(dateStr);
    const isPubHol = this.isPublicHoliday(dateStr);
    const customHol = this.getCustomHoliday(dateStr);

    if (customHol) {
      if (statusBadge) {
        statusBadge.className = 'badge-pill-item amber-tag';
        statusBadge.textContent = 'วันหยุดพิเศษ (กำหนดเอง)';
      }
      if (reasonNote) {
        reasonNote.style.display = 'block';
        reasonNote.innerHTML = `<strong>เหตุผล:</strong> ${this.escapeHtml(customHol.reason || 'โรงเรียนสั่งหยุด/น้ำท่วม/เหตุฉุกเฉิน')} (ค่าเช่าร้านวันขาย = ฿0)`;
      }
      if (toggleBtn) {
        toggleBtn.className = 'btn-outline-fastwork w-full btn-sm';
        toggleBtn.style.color = '#ef4444';
        toggleBtn.style.background = '#fef2f2';
        toggleBtn.style.borderColor = '#fecaca';
      }
      if (toggleText) toggleText.textContent = 'ยกเลิกวันหยุดพิเศษ (กลับเป็นวันปกติ)';
    } else if (isPubHol) {
      if (statusBadge) {
        statusBadge.className = 'badge-pill-item red-tag';
        statusBadge.textContent = 'วันหยุดนักขัตฤกษ์';
      }
      if (reasonNote) {
        reasonNote.style.display = 'block';
        reasonNote.textContent = 'วันหยุดตามปฏิทินราชการ / วันหยุดนักขัตฤกษ์ (ค่าเช่าร้าน = ฿0)';
      }
      if (toggleBtn) {
        toggleBtn.className = 'btn-fastwork w-full btn-sm';
        toggleBtn.style.color = '#ffffff';
        toggleBtn.style.background = 'var(--amber, #f59e0b)';
        toggleBtn.style.borderColor = '#d97706';
      }
      if (toggleText) toggleText.textContent = '+ เพิ่มวันหยุดพิเศษ';
    } else if (isWk) {
      if (statusBadge) {
        statusBadge.className = 'badge-pill-item purple-tag';
        statusBadge.textContent = 'วันหยุดเสาร์-อาทิตย์';
      }
      if (reasonNote) {
        reasonNote.style.display = 'none';
      }
      if (toggleBtn) {
        toggleBtn.className = 'btn-fastwork w-full btn-sm';
        toggleBtn.style.color = '#ffffff';
        toggleBtn.style.background = 'var(--amber, #f59e0b)';
        toggleBtn.style.borderColor = '#d97706';
      }
      if (toggleText) toggleText.textContent = '+ เพิ่มวันหยุดพิเศษ';
    } else {
      if (statusBadge) {
        statusBadge.className = 'badge-pill-item green-tag';
        statusBadge.textContent = 'วันเปิดเรียนปกติ';
      }
      if (reasonNote) {
        reasonNote.style.display = 'none';
      }
      if (toggleBtn) {
        toggleBtn.className = 'btn-fastwork w-full btn-sm';
        toggleBtn.style.color = '#ffffff';
        toggleBtn.style.background = 'var(--amber, #f59e0b)';
        toggleBtn.style.borderColor = '#d97706';
      }
      if (toggleText) toggleText.textContent = '+ เพิ่มวันหยุดพิเศษ';
    }

    const listContainer = document.getElementById('calDayBillsList');
    if (!listContainer) return;

    if (!record) {
      const isHol = isPubHol || !!customHol;
      let emptyMsg = 'ยังไม่ได้บันทึกยอดขายของวันนี้';
      if (customHol) emptyMsg = `วันนี้ถูกกำหนดเป็นวันหยุดพิเศษ: ${customHol.reason || 'น้ำท่วม/โรงเรียนปิด'}`;
      else if (isPubHol) emptyMsg = 'วันนี้เป็นวันหยุดนักขัตฤกษ์ / โรงเรียนปิด';
      else if (isWk) emptyMsg = 'วันหยุดสุดสัปดาห์ (เสาร์-อาทิตย์)';

      listContainer.innerHTML = `<p class="text-muted text-sm py-4 text-center">${this.escapeHtml(emptyMsg)}</p>`;
      return;
    }

    let dayStatusText = 'วันเปิดเรียนปกติ';
    if (customHol) dayStatusText = `วันหยุดพิเศษ: ${customHol.reason || 'น้ำท่วม/โรงเรียนปิด'} (ค่าเช่า ฿0)`;
    else if (isPubHol) dayStatusText = 'วันหยุดนักขัตฤกษ์ / วันหยุดโรงเรียน (ค่าเช่า ฿0)';
    else if (isWk) dayStatusText = 'วันหยุดเสาร์-อาทิตย์ โรงเรียนปิด (ค่าเช่า ฿0)';

    listContainer.innerHTML = `
      <div class="day-bill-item">
        <div>
          <div class="font-bold">ยอดเงินที่ได้ทั้งหมด: ${this.formatCurrency(record.revenue)}</div>
          <div class="text-muted text-sm">
            หักต้นทุน: ${this.formatCurrency(record.cost)} 
            (${record.dailyRent > 0 ? `รวมค่าเช่า ฿${record.dailyRent}` : 'ไม่คิดค่าเช่า'}) &bull; 
            ${this.escapeHtml(record.note || dayStatusText)}
          </div>
        </div>
        <div class="text-right">
          <div class="font-bold ${isProfit ? 'text-green' : 'text-danger'}">
            ${isProfit ? `+${this.formatCurrency(profit)}` : `-${this.formatCurrency(Math.abs(profit))}`}
          </div>
          <div class="text-muted text-sm">${isProfit ? 'กำไรสุทธิ' : 'ขาดทุน'}</div>
        </div>
      </div>
    `;
  }

  toggleSelectedDayHoliday() {
    const dateStr = this.selectedCalendarDayStr;
    if (!dateStr) return;

    if (!Array.isArray(this.data.customHolidays)) {
      this.data.customHolidays = [];
    }

    const existingIndex = this.data.customHolidays.findIndex(h => h.date === dateStr);
    if (existingIndex !== -1) {
      // Remove holiday
      this.data.customHolidays.splice(existingIndex, 1);
      this.saveData();
      this.showToast(`ยกเลิกวันหยุดพิเศษของวันที่ ${this.formatThaiDate(dateStr)} แล้ว`, 'info');

      const formDate = document.getElementById('dailyFormDate')?.value;
      if (formDate === dateStr) {
        this.loadDailyFormForDate(dateStr);
      }
      this.renderCalendar();
      this.renderDashboard();
    } else {
      // Open modal with this day pre-selected
      this.openCustomHolidayModal([dateStr]);
    }
  }

  // Multi-day Custom Holiday Modal Logic
  openCustomHolidayModal(initialDates = null) {
    const modal = document.getElementById('customHolidayModal');
    if (!modal) return;

    this.selectedBatchHolidayDates = new Set();

    if (initialDates && Array.isArray(initialDates) && initialDates.length > 0) {
      initialDates.forEach(d => this.selectedBatchHolidayDates.add(d));
      // Set picker month to match the initial date
      const parts = initialDates[0].split('-');
      if (parts.length === 3) {
        this.holidayPickerMonthDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, 1);
      }
    } else {
      // Default to currently selected calendar day or current date
      const currentTarget = this.selectedCalendarDayStr || this.formatDate(new Date());
      this.selectedBatchHolidayDates.add(currentTarget);
      const parts = currentTarget.split('-');
      if (parts.length === 3) {
        this.holidayPickerMonthDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, 1);
      }
    }

    this.renderHolidayPickerGrid();
    this.renderHolidaySelectedChips();

    modal.classList.add('active');
    if (window.lucide) window.lucide.createIcons();
  }

  renderHolidayPickerGrid() {
    const grid = document.getElementById('holidayPickerGrid');
    const label = document.getElementById('holidayModalMonthLabel');
    if (!grid) return;

    const pickerYear = this.holidayPickerMonthDate.getFullYear();
    const pickerMonth = this.holidayPickerMonthDate.getMonth();

    if (label) {
      label.textContent = this.formatThaiMonthYear(pickerYear, pickerMonth);
    }

    const firstDayIndex = new Date(pickerYear, pickerMonth, 1).getDay();
    const daysInCurrentMonth = new Date(pickerYear, pickerMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(pickerYear, pickerMonth, 0).getDate();
    const todayStr = this.formatDate(new Date());

    let cellsHtml = '';

    // Prev month inactive cells
    for (let i = firstDayIndex - 1; i >= 0; i--) {
      const dayNum = daysInPrevMonth - i;
      cellsHtml += `
        <div class="holiday-picker-cell inactive">
          <span class="picker-day-num text-muted">${dayNum}</span>
        </div>
      `;
    }

    // Days in current month
    for (let day = 1; day <= daysInCurrentMonth; day++) {
      const dateStr = `${pickerYear}-${String(pickerMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isSelected = this.selectedBatchHolidayDates.has(dateStr);
      const isWk = this.isWeekend(dateStr);
      const isPublicHol = this.isPublicHoliday(dateStr);
      const customHol = this.getCustomHoliday(dateStr);
      const isToday = (dateStr === todayStr);

      let tagHtml = '';
      if (customHol) {
        tagHtml = `<span class="picker-day-tag" style="background:#ffedd5; color:#c2410c;">หยุดพิเศษ</span>`;
      } else if (isPublicHol) {
        tagHtml = `<span class="picker-day-tag" style="background:#fee2e2; color:#dc2626;">วันหยุด</span>`;
      } else if (isWk) {
        tagHtml = `<span class="picker-day-tag" style="background:#f1f5f9; color:#64748b;">ส-อา</span>`;
      } else if (isToday) {
        tagHtml = `<span class="picker-day-tag" style="background:#dbeafe; color:#1d4ed8;">วันนี้</span>`;
      }

      cellsHtml += `
        <div class="holiday-picker-cell ${isSelected ? 'selected' : ''} ${customHol ? 'is-custom-holiday' : ''} ${isPublicHol ? 'is-public-holiday' : ''} ${isWk ? 'is-weekend' : ''}" 
             onclick="app.togglePickerDate('${dateStr}')" title="${dateStr}">
          <div class="w-full space-between align-center">
            <span class="picker-day-num">${day}</span>
            ${isSelected ? '<span class="picker-check-badge">✓</span>' : ''}
          </div>
          ${tagHtml}
        </div>
      `;
    }

    grid.innerHTML = cellsHtml;

    // Update count badge
    const countBadge = document.getElementById('holidayModalSelectedCount');
    if (countBadge) {
      countBadge.textContent = `เลือกแล้ว ${this.selectedBatchHolidayDates.size} วัน`;
    }
  }

  togglePickerDate(dateStr) {
    if (this.selectedBatchHolidayDates.has(dateStr)) {
      this.selectedBatchHolidayDates.delete(dateStr);
    } else {
      this.selectedBatchHolidayDates.add(dateStr);
    }
    this.renderHolidayPickerGrid();
    this.renderHolidaySelectedChips();
  }

  removePickerDate(dateStr) {
    this.selectedBatchHolidayDates.delete(dateStr);
    this.renderHolidayPickerGrid();
    this.renderHolidaySelectedChips();
  }

  selectSchoolDaysForPickerMonth() {
    const pickerYear = this.holidayPickerMonthDate.getFullYear();
    const pickerMonth = this.holidayPickerMonthDate.getMonth();
    const daysInCurrentMonth = new Date(pickerYear, pickerMonth + 1, 0).getDate();

    for (let day = 1; day <= daysInCurrentMonth; day++) {
      const dateStr = `${pickerYear}-${String(pickerMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (!this.isWeekend(dateStr)) {
        this.selectedBatchHolidayDates.add(dateStr);
      }
    }
    this.renderHolidayPickerGrid();
    this.renderHolidaySelectedChips();
  }

  renderHolidaySelectedChips() {
    const container = document.getElementById('holidaySelectedChipsList');
    if (!container) return;

    if (this.selectedBatchHolidayDates.size === 0) {
      container.innerHTML = `<span class="text-muted text-xs">ยังไม่ได้เลือกวัน (คลิกเลือกวันที่ต้องการในปฏิทินด้านบนได้เลย)</span>`;
      return;
    }

    // Sort dates
    const sortedDates = Array.from(this.selectedBatchHolidayDates).sort();
    let chipsHtml = '';

    sortedDates.forEach(dateStr => {
      const formatted = this.formatThaiDate(dateStr, false);
      chipsHtml += `
        <span class="holiday-chip">
          <span>${formatted}</span>
          <button type="button" class="holiday-chip-remove" onclick="app.removePickerDate('${dateStr}')" title="ลบวันที่นี้">✕</button>
        </span>
      `;
    });

    container.innerHTML = chipsHtml;
  }

  saveBatchHolidays() {
    if (this.selectedBatchHolidayDates.size === 0) {
      this.showToast('กรุณาคลิกเลือกวันที่ต้องการกำหนดเป็นวันหยุดพิเศษอย่างน้อย 1 วัน', 'warning');
      return;
    }

    const reasonInput = document.getElementById('holidayModalReasonInput');
    const reason = (reasonInput && reasonInput.value.trim()) ? reasonInput.value.trim() : 'วันหยุดพิเศษ (เช่น น้ำท่วม/โรงเรียนปิด)';

    if (!Array.isArray(this.data.customHolidays)) {
      this.data.customHolidays = [];
    }

    let addedCount = 0;
    this.selectedBatchHolidayDates.forEach(dateStr => {
      const existing = this.data.customHolidays.find(h => h.date === dateStr);
      if (existing) {
        existing.reason = reason;
      } else {
        this.data.customHolidays.push({
          date: dateStr,
          reason: reason,
          createdAt: this.formatDate(new Date())
        });
        addedCount++;
      }
    });

    this.saveData();

    // Close modal
    const modal = document.getElementById('customHolidayModal');
    if (modal) modal.classList.remove('active');

    this.showToast(`บันทึกวันหยุดพิเศษสำเร็จ (${this.selectedBatchHolidayDates.size} วัน)`, 'success');

    // Reload form if current form date affected
    const formDate = document.getElementById('dailyFormDate')?.value;
    if (formDate && this.selectedBatchHolidayDates.has(formDate)) {
      this.loadDailyFormForDate(formDate);
    }

    this.renderCalendar();
    this.renderDashboard();
  }

  // -------------------------------------------------------------------------
  // TAB 6: RECIPES (สูตร 1 โหล)
  // -------------------------------------------------------------------------
  syncRecipesWithExpenses() {
    if (!this.data.recipes || !this.data.expenses) return;
    let modified = false;

    this.data.recipes.forEach(recipe => {
      if (!recipe.ingredients) return;
      recipe.ingredients.forEach(ing => {
        let matchedExp = null;
        if (ing.calcData && ing.calcData.expenseId) {
          matchedExp = this.data.expenses.find(e => e.id === ing.calcData.expenseId);
        }
        if (!matchedExp && ing.name) {
          const lowerName = ing.name.toLowerCase();
          matchedExp = this.data.expenses.find(e => {
            const t = (e.title || '').toLowerCase();
            return t.includes(lowerName) || lowerName.includes(t.split(' ')[0]);
          });
        }

        if (matchedExp && matchedExp.amount !== undefined) {
          const latestPrice = parseFloat(matchedExp.amount) || 0;
          const latestSize = parseFloat(matchedExp.packSize) || (ing.calcData?.packSize || 1);
          const latestUnit = matchedExp.packUnit || ing.calcData?.packUnit || 'กรัม';
          const useAmount = ing.calcData?.useAmount !== undefined ? parseFloat(ing.calcData.useAmount) : 0;

          if (!ing.calcData) {
            ing.calcData = {
              expenseId: matchedExp.id,
              packPrice: latestPrice,
              packSize: latestSize,
              packUnit: latestUnit,
              useAmount: useAmount
            };
          } else {
            ing.calcData.expenseId = matchedExp.id;
            ing.calcData.packPrice = latestPrice;
            ing.calcData.packSize = latestSize;
            ing.calcData.packUnit = latestUnit;
          }

          if (latestPrice > 0 && latestSize > 0 && useAmount > 0) {
            const updatedCost = Math.round(((latestPrice / latestSize) * useAmount) * 100) / 100;
            if (ing.cost !== updatedCost) {
              ing.cost = updatedCost;
              modified = true;
            }
          }
        }
      });
    });

    if (modified) {
      this.saveData();
    }
  }

  calculateRecipeJarCost(recipe) {
    if (!recipe.ingredients) return 0;
    return recipe.ingredients.reduce((acc, ing) => acc + (Number(ing.cost) || 0), 0);
  }

  calculateRecipeUnitCost(recipe) {
    const jarCost = this.calculateRecipeJarCost(recipe);
    const cups = parseInt(recipe.yieldCups) || 12;
    return cups > 0 ? (jarCost / cups) : 0;
  }

  setRecipeFilter(filter = 'all') {
    this.recipeActiveFilter = filter;
    const pills = document.querySelectorAll('#recipeFilterPills .figma-pill-filter');
    pills.forEach(pill => {
      if (pill.getAttribute('data-filter') === filter) pill.classList.add('active');
      else pill.classList.remove('active');
    });
    this.renderRecipes();
  }

  renderRecipes() {
    this.syncRecipesWithExpenses();
    const container = document.getElementById('recipesGridContainer');
    if (!container) return;

    const allRecipes = this.data.recipes || [];

    // 1. Calculate Summary Metrics for Hero Card
    let cupCount = 0;
    let jarCount = 0;
    let totalMarginSum = 0;
    let marginCount = 0;

    allRecipes.forEach(recipe => {
      const mode = recipe.mode || (recipe.yieldCups === 1 && (!recipe.jarLiters || recipe.jarLiters <= 0.5) ? 'cup' : 'jar');
      if (mode === 'cup') cupCount++;
      else jarCount++;

      const isCup = mode === 'cup';
      const jarCost = this.calculateRecipeJarCost(recipe);
      const unitCost = isCup ? jarCost : this.calculateRecipeUnitCost(recipe);
      const sellingPrice = recipe.sellingPrice !== undefined ? Number(recipe.sellingPrice) : (recipe.suggestedPrice || 25);
      const profitPerCup = sellingPrice - unitCost;
      const margin = sellingPrice > 0 ? ((profitPerCup / sellingPrice) * 100) : 0;
      totalMarginSum += margin;
      marginCount++;
    });

    const avgMargin = marginCount > 0 ? (totalMarginSum / marginCount).toFixed(0) : 0;

    const totalCountBadge = document.getElementById('recipeTotalCountBadge');
    const countCupElem = document.getElementById('recipeCountCup');
    const countJarElem = document.getElementById('recipeCountJar');
    const avgMarginElem = document.getElementById('recipeAvgMargin');

    if (totalCountBadge) totalCountBadge.textContent = `${allRecipes.length} เมนู`;
    if (countCupElem) countCupElem.textContent = `${cupCount} สูตร`;
    if (countJarElem) countJarElem.textContent = `${jarCount} สูตร`;
    if (avgMarginElem) avgMarginElem.textContent = `${avgMargin}%`;

    // 2. Filter list by Active Filter & Search Query
    const activeFilter = this.recipeActiveFilter || 'all';
    const searchQuery = (this.recipeSearchQuery || '').toLowerCase();

    let filtered = allRecipes.filter(recipe => {
      const mode = recipe.mode || (recipe.yieldCups === 1 && (!recipe.jarLiters || recipe.jarLiters <= 0.5) ? 'cup' : 'jar');
      if (activeFilter !== 'all' && mode !== activeFilter) return false;

      if (searchQuery) {
        const nameMatch = (recipe.name || '').toLowerCase().includes(searchQuery);
        const ingMatch = (recipe.ingredients || []).some(ing => (ing.name || '').toLowerCase().includes(searchQuery));
        if (!nameMatch && !ingMatch) return false;
      }
      return true;
    });

    const recipeSort = document.getElementById('recipeSortOrder')?.value || 'newest';
    filtered.sort((a, b) => {
      const idA = String(a.id || '');
      const idB = String(b.id || '');
      const cmp = idA.localeCompare(idB);
      if (recipeSort === 'oldest') {
        return cmp;
      }
      return -cmp;
    });

    const filteredBadge = document.getElementById('recipeFilteredCountBadge');
    if (filteredBadge) filteredBadge.textContent = `${filtered.length} รายการ`;

    // 3. Render Modern Card Stream
    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="figma-tx-empty">
          <div class="figma-empty-icon"><i data-lucide="beaker"></i></div>
          <div class="figma-empty-text">ไม่พบสูตรชงน้ำที่ค้นหา</div>
          <div class="figma-empty-sub">ลองเปลี่ยนคำค้นหา หรือแตะปุ่ม "+ สร้างสูตรชงใหม่" ด้านบน</div>
        </div>
      `;
      this.refreshLucide();
      return;
    }

    container.innerHTML = filtered.map(recipe => {
      const mode = recipe.mode || (recipe.yieldCups === 1 && (!recipe.jarLiters || recipe.jarLiters <= 0.5) ? 'cup' : 'jar');
      const isCup = mode === 'cup';
      const jarCost = this.calculateRecipeJarCost(recipe);
      const unitCost = isCup ? jarCost : this.calculateRecipeUnitCost(recipe);
      const yieldCups = isCup ? 1 : (recipe.yieldCups || 12);
      const sellingPrice = recipe.sellingPrice !== undefined ? Number(recipe.sellingPrice) : (recipe.suggestedPrice || 25);
      const profitPerCup = sellingPrice - unitCost;
      const marginPercent = sellingPrice > 0 ? Math.round(((profitPerCup / sellingPrice) * 100)) : 0;
      const totalJarProfit = profitPerCup * yieldCups;
      const isProfit = profitPerCup >= 0;

      const capacityText = isCup
        ? `ชงแก้ว ${recipe.cupSizeOz || 16} oz (ชงสด)`
        : `${this.escapeHtml(recipe.jarCapacity || '1 โหล')} (~${yieldCups} แก้ว)`;

      const ingredientsList = recipe.ingredients || [];

      return `
        <div class="figma-recipe-card ${isCup ? 'mode-cup' : 'mode-jar'}">
          <!-- Card Top Row -->
          <div class="frc-top">
            <div class="frc-left">
              <div class="frc-avatar ${isCup ? 'cup' : 'jar'}">
                ${isCup ? '🥤' : '🏺'}
              </div>
              <div class="frc-name-wrap">
                <div class="frc-tags-row">
                  <span class="frc-badge ${isCup ? 'cup' : 'jar'}">
                    ${isCup ? 'สูตร 1 แก้ว' : 'สูตร 1 โหล'}
                  </span>
                  <span class="frc-capacity">${capacityText}</span>
                </div>
                <div class="frc-title">${this.escapeHtml(recipe.name)}</div>
              </div>
            </div>
            <div class="frc-right">
              <span class="frc-price">฿${sellingPrice.toFixed(0)}</span>
              <span class="frc-profit-pill">กำไร ${marginPercent}%</span>
            </div>
          </div>

          <!-- Key Metrics 3-Column Strip -->
          <div class="frc-metrics-strip">
            <div class="frc-metric-col">
              <span class="frc-metric-lbl">${isCup ? 'ทุนวัตถุดิบ' : 'ทุนรวม 1 โหล'}</span>
              <span class="frc-metric-val text-amber">${isCup ? `฿${unitCost.toFixed(2)}` : this.formatCurrency(jarCost)}</span>
            </div>
            <div class="frc-metric-col">
              <span class="frc-metric-lbl">ทุนเฉลี่ย/แก้ว</span>
              <span class="frc-metric-val text-amber">฿${unitCost.toFixed(2)}</span>
            </div>
            <div class="frc-metric-col">
              <span class="frc-metric-lbl">กำไรสุทธิ/แก้ว</span>
              <span class="frc-metric-val ${isProfit ? 'text-green' : 'text-danger'}">
                ${isProfit ? `+฿${profitPerCup.toFixed(2)}` : `-฿${Math.abs(profitPerCup).toFixed(2)}`}
              </span>
            </div>
          </div>

          <!-- Ingredients Chips Preview -->
          ${ingredientsList.length > 0 ? `
            <div class="frc-ingredients-box">
              <div class="frc-ing-label">
                <i data-lucide="layers" style="width:13px;height:13px;display:inline-block;vertical-align:-2px;"></i>
                ${isCup ? 'ส่วนผสมต่อ 1 แก้ว' : `ส่วนผสมต่อ 1 โหล (${yieldCups} แก้ว)`} (${ingredientsList.length} รายการ):
              </div>
              <div class="frc-chips-wrap">
                ${ingredientsList.map(ing => {
        return `
                    <span class="frc-chip" title="ต้นทุน ฿${Number(ing.cost || 0).toFixed(2)}">
                      <span>${this.escapeHtml(ing.name)}</span>
                      <small class="text-muted">(${this.escapeHtml(ing.amount)})</small>
                      <strong>฿${Number(ing.cost || 0).toFixed(1)}</strong>
                    </span>
                  `;
      }).join('')}
              </div>
            </div>
          ` : ''}

          <!-- Optional Instructions Note -->
          ${recipe.instructions ? `
            <div class="frc-note-box">
              <strong>วิธีชง/เทคนิค:</strong> ${this.escapeHtml(recipe.instructions)}
            </div>
          ` : ''}

          <!-- Card Actions Footer -->
          <div class="frc-actions">
            <span class="frc-total-summary">
              ${isCup ? `กำไร +฿${profitPerCup.toFixed(2)}/แก้ว` : `ขายหมดโหลได้กำไร ~${this.formatCurrency(totalJarProfit)}`}
            </span>
            <div class="frc-btns-group">
              <button class="btn-figma-tx-action" onclick="app.openRecipeModal('${recipe.id}')" title="แก้ไขสูตร">
                <i data-lucide="edit-3"></i>
                <span>แก้ไข</span>
              </button>
              <button class="btn-figma-tx-action danger" onclick="app.deleteRecipe('${recipe.id}')" title="ลบสูตร">
                <i data-lucide="trash-2"></i>
                <span>ลบ</span>
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    this.refreshLucide();
  }

  deleteRecipe(recipeId) {
    if (confirm('คุณต้องการลบสูตรชงน้ำนี้ใช่หรือไม่?')) {
      this.data.recipes = this.data.recipes.filter(r => r.id !== recipeId);
      this.saveData();
      this.showToast('ลบสูตรชงน้ำแล้ว', 'info');
      this.renderRecipes();
    }
  }

  // -------------------------------------------------------------------------
  // MODALS
  // -------------------------------------------------------------------------
  openExpenseModal(expId = null) {
    const modal = document.getElementById('expenseModal');
    const form = document.getElementById('expenseForm');
    form.reset();

    const titleElem = document.getElementById('expenseModalTitle');
    const editIdInput = document.getElementById('expenseEditId');
    const dateInput = document.getElementById('expDateInput');

    dateInput.value = this.formatDate(new Date());

    if (expId) {
      const exp = (this.data.expenses || []).find(e => e && String(e.id) === String(expId));
      if (exp) {
        titleElem.textContent = 'แก้ไขค่าใช้จ่าย & รายการสต๊อก';
        editIdInput.value = exp.id;

        let dateVal = this.formatDate(new Date());
        if (exp.date) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(exp.date)) {
            dateVal = exp.date;
          } else if (typeof exp.date === 'string' && exp.date.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(exp.date)) {
            dateVal = exp.date.substring(0, 10);
          }
        }
        dateInput.value = dateVal;

        document.getElementById('expTitle').value = exp.title || '';
        document.getElementById('expCategory').value = exp.category || 'INGREDIENT';
        document.getElementById('expAmount').value = (exp.amount !== undefined && exp.amount !== '') ? exp.amount : 0;
        const qtyDescEl = document.getElementById('expQuantityDesc');
        if (qtyDescEl) qtyDescEl.value = exp.qtyDesc || '';

        const packSizeInput = document.getElementById('expPackSize');
        const parsedPack = parseFloat(exp.packSize);
        if (packSizeInput) packSizeInput.value = (!isNaN(parsedPack) && parsedPack > 0) ? parsedPack : 1;

        // Pack Unit & Custom Unit setup
        const unitSelect = document.getElementById('expPackUnit');
        const customUnitInput = document.getElementById('expPackUnitCustom');
        const targetUnit = exp.packUnit || 'หน่วย';
        const optExists = unitSelect && Array.from(unitSelect.options).some(o => o.value === targetUnit);
        if (optExists) {
          unitSelect.value = targetUnit;
          if (customUnitInput) customUnitInput.style.display = 'none';
        } else if (unitSelect) {
          unitSelect.value = 'CUSTOM';
          if (customUnitInput) {
            customUnitInput.style.display = 'block';
            customUnitInput.value = targetUnit;
          }
        }

        const expSupplierEl = document.getElementById('expSupplier');
        if (expSupplierEl) expSupplierEl.value = exp.supplier || '';
        document.getElementById('expNote').value = exp.note || '';

        // Crate bottles setup
        const crateBottlesInput = document.getElementById('expCrateBottles');
        if (crateBottlesInput) {
          crateBottlesInput.value = exp.crateBottles || 24;
        }

        // Match existing stock item if available
        const expTitleClean = String(exp.title || '').split('(')[0].trim().toLowerCase();
        const matched = (this.data.stockItems || []).find(s => {
          if (!s || !s.name) return false;
          if (exp.stockItemId && String(s.id) === String(exp.stockItemId)) return true;
          const sClean = String(s.name).split('(')[0].trim().toLowerCase();
          const sNameLower = String(s.name).toLowerCase();
          const expTitleLower = String(exp.title || '').toLowerCase();
          return sNameLower === expTitleLower || sClean === expTitleClean || sClean.includes(expTitleClean) || expTitleClean.includes(sClean);
        });

        if (matched && expSupplierEl && !exp.supplier && matched.supplier) {
          expSupplierEl.value = matched.supplier;
        }

        const expMinInput = document.getElementById('expMinQty');
        const noAlertCb = document.getElementById('expNoAlertCheckbox');
        let initialMin = 5;
        if (exp.minQty !== undefined) {
          initialMin = Number(exp.minQty);
        } else if (matched && matched.minQty !== undefined) {
          initialMin = Number(matched.minQty);
        }

        if (expMinInput) {
          expMinInput.value = initialMin;
        }
        if (noAlertCb) {
          noAlertCb.checked = (initialMin === 0);
          if (expMinInput) {
            expMinInput.disabled = (initialMin === 0);
            expMinInput.style.opacity = (initialMin === 0) ? '0.45' : '1';
          }
        }
      }
    } else {
      titleElem.textContent = 'บันทึกค่าใช้จ่าย & รับเข้าสต๊อกร้านค้า';
      editIdInput.value = '';
      document.getElementById('expPackSize').value = 1;
      document.getElementById('expPackUnit').value = 'ลัง';
      const customUnitInput = document.getElementById('expPackUnitCustom');
      if (customUnitInput) customUnitInput.style.display = 'none';
      const crateBottlesInput = document.getElementById('expCrateBottles');
      if (crateBottlesInput) crateBottlesInput.value = 24;
      const expMinInput = document.getElementById('expMinQty');
      const noAlertCb = document.getElementById('expNoAlertCheckbox');
      if (expMinInput) {
        expMinInput.value = 5;
        expMinInput.disabled = false;
        expMinInput.style.opacity = '1';
      }
      if (noAlertCb) {
        noAlertCb.checked = false;
      }
    }

    // Wire noAlertCheckbox toggle
    const noAlertCb = document.getElementById('expNoAlertCheckbox');
    if (noAlertCb) {
      noAlertCb.onchange = () => {
        const minInput = document.getElementById('expMinQty');
        if (noAlertCb.checked) {
          if (minInput) {
            minInput.dataset.previousVal = minInput.value || '5';
            minInput.value = 0;
            minInput.disabled = true;
            minInput.style.opacity = '0.45';
          }
        } else {
          if (minInput) {
            const restored = parseFloat(minInput.dataset.previousVal) || 5;
            minInput.value = restored > 0 ? restored : 5;
            minInput.disabled = false;
            minInput.style.opacity = '1';
          }
        }
        this.updateExpenseModalPreview();
      };
    }

    this.updateExpenseModalPreview();

    // Wire live preview calculation listeners
    ['expAmount', 'expPackSize', 'expPackUnit', 'expTitle', 'expCrateBottles', 'expMinQty', 'expPackUnitCustom'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.oninput = () => {
          if (id === 'expTitle') {
            this.handleExpenseTitleAutoFill();
          }
          this.updateExpenseModalPreview();
        };
        if (id === 'expPackUnit') {
          el.onchange = () => {
            const customInput = document.getElementById('expPackUnitCustom');
            if (el.value === 'CUSTOM') {
              if (customInput) {
                customInput.style.display = 'block';
                customInput.focus();
              }
            } else {
              if (customInput) customInput.style.display = 'none';
            }
            this.updateExpenseModalPreview();
          };
        }
      }
    });

    modal.classList.add('active');
    this.refreshLucide();
  }

  handleExpenseTitleAutoFill() {
    const titleVal = document.getElementById('expTitle')?.value.trim().toLowerCase();
    if (!titleVal) return;

    const matched = (this.data.stockItems || []).find(s => s && s.name && s.name.toLowerCase() === titleVal);
    if (matched) {
      if (matched.category && document.getElementById('expCategory')) {
        document.getElementById('expCategory').value = matched.category;
      }
      const unitSelect = document.getElementById('expPackUnit');
      const customInput = document.getElementById('expPackUnitCustom');
      if (matched.unit && unitSelect) {
        if (matched.unit.includes('ขวด') || matched.unit.includes('ลัง')) {
          unitSelect.value = 'ลัง';
          if (customInput) customInput.style.display = 'none';
        } else {
          // Check if option exists in select
          const optExists = Array.from(unitSelect.options).some(o => o.value === matched.unit);
          if (optExists) {
            unitSelect.value = matched.unit;
            if (customInput) customInput.style.display = 'none';
          } else {
            unitSelect.value = 'CUSTOM';
            if (customInput) {
              customInput.style.display = 'block';
              customInput.value = matched.unit;
            }
          }
        }
      }
      if (matched.supplier && document.getElementById('expSupplier')) {
        const supInput = document.getElementById('expSupplier');
        if (!supInput.value.trim()) {
          supInput.value = matched.supplier;
        }
      }
      if (matched.minQty && document.getElementById('expMinQty')) {
        document.getElementById('expMinQty').value = matched.minQty;
      }
    }
  }

  updateExpenseModalPreview() {
    const amount = parseFloat(document.getElementById('expAmount')?.value) || 0;
    const packSize = parseFloat(document.getElementById('expPackSize')?.value) || 0;
    const unitSelect = document.getElementById('expPackUnit');
    const customInput = document.getElementById('expPackUnitCustom');
    let unit = unitSelect ? unitSelect.value : 'หน่วย';
    if (unit === 'CUSTOM' && customInput && customInput.value.trim()) {
      unit = customInput.value.trim();
    }
    const titleVal = document.getElementById('expTitle')?.value.trim().toLowerCase();
    const crateContainer = document.getElementById('expCrateBottlesContainer');
    const minQtyInput = document.getElementById('expMinQty');
    const minQtyLabel = document.getElementById('expMinQtyLabel');
    const minQtyHint = document.getElementById('expMinQtyHint');

    const isCrate = unit.includes('ลัง') || unit.toLowerCase() === 'crate';

    let bottlesPerCrate = 24;
    if (isCrate) {
      if (crateContainer) crateContainer.style.display = 'block';
      const crateBottlesVal = parseFloat(document.getElementById('expCrateBottles')?.value);
      bottlesPerCrate = !isNaN(crateBottlesVal) && crateBottlesVal > 0 ? crateBottlesVal : 24;

      // Summary inside crate container
      const totalBottles = packSize * bottlesPerCrate;
      const costPerBottle = totalBottles > 0 ? (amount / totalBottles) : 0;
      const summaryEl = document.getElementById('expCrateTotalBottlesSummary');
      if (summaryEl) {
        summaryEl.textContent = `(ตกขวดละ ฿${costPerBottle.toFixed(2)})`;
      }
    } else {
      if (crateContainer) crateContainer.style.display = 'none';
    }

    const noAlertCb = document.getElementById('expNoAlertCheckbox');
    const isNoAlert = (noAlertCb && noAlertCb.checked) || (parseFloat(minQtyInput?.value) === 0);

    if (minQtyLabel) {
      minQtyLabel.innerHTML = isNoAlert ? `🚫 การแจ้งเตือนสต๊อก` : `⚠️ เกณฑ์เตือนสั่งซื้อขั้นต่ำ (Min Qty)`;
      minQtyLabel.style.color = isNoAlert ? 'var(--text-muted)' : 'var(--danger)';
    }
    if (minQtyHint) {
      minQtyHint.textContent = isNoAlert
        ? 'ตั้งค่า "ไม่ต้องเตือนซื้อ" แล้ว: ระบบจะไม่นำรายการนี้ไปแสดงเตือนในหน้าสินค้าใกล้หมด'
        : 'หากคงเหลือต่ำกว่าเกณฑ์นี้ ระบบจะเตือนสั่งซื้อ (หรือติ๊ก "ไม่ต้องเตือนซื้อ" สำหรับของใช้ถาวร)';
      minQtyHint.style.color = isNoAlert ? '#64748b' : '';
    }

    // Cost preview
    const costPreviewEl = document.getElementById('expCalculatedUnitCostPreview');
    const syncStatusEl = document.getElementById('expStockStatusSyncPreview');

    if (costPreviewEl) {
      if (isCrate) {
        const totalBottles = packSize * bottlesPerCrate;
        const bottleCost = totalBottles > 0 ? (amount / totalBottles) : 0;
        const crateCost = packSize > 0 ? (amount / packSize) : 0;
        costPreviewEl.innerHTML = `฿${bottleCost.toFixed(2)} / ขวด <span style="font-size:0.8rem; font-weight:normal; color:var(--text-muted);">(ลังละ ฿${crateCost.toFixed(2)})</span>`;
      } else {
        const unitCost = packSize > 0 ? (amount / packSize) : 0;
        costPreviewEl.textContent = `฿${unitCost.toFixed(2)} / ${unit}`;
      }
    }

    if (syncStatusEl) {
      const editId = document.getElementById('expenseEditId')?.value;
      const titleClean = String(titleVal || '').split('(')[0].trim().toLowerCase();
      const matched = (this.data.stockItems || []).find(s => {
        if (!s || !s.name) return false;
        const sClean = String(s.name).split('(')[0].trim().toLowerCase();
        const sNameLower = String(s.name).toLowerCase();
        const titleLower = String(titleVal || '').toLowerCase();
        return sNameLower === titleLower || sClean === titleClean || sClean.includes(titleClean) || titleClean.includes(sClean);
      });

      if (editId) {
        const oldExp = (this.data.expenses || []).find(e => e && String(e.id) === String(editId));
        const oldPack = oldExp ? (Number(oldExp.packSize) || 1) : packSize;
        const diff = packSize - oldPack;
        const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
        if (matched) {
          const currentQty = Number(matched.qty) || 0;
          const newQty = Math.max(0, currentQty + diff);
          syncStatusEl.textContent = `🔄 อัปเดตสต๊อกเดิม "${matched.name}" (คงเหลือ ${currentQty} -> เป็น ${newQty} ${matched.unit || unit} [${diffStr}])`;
          syncStatusEl.className = 'pill-tag blue-tag';
        } else {
          syncStatusEl.textContent = `🔄 อัปเดตและสร้างสต๊อกใหม่ "${titleVal || 'สินค้านี้'}" (${packSize} ${unit})`;
          syncStatusEl.className = 'pill-tag green-tag';
        }
      } else {
        if (isCrate) {
          if (matched) {
            const newQty = matched.qty + packSize;
            syncStatusEl.textContent = `📦 เติมสต๊อกเดิม (ปัจจุบันมี ${matched.qty} -> รับเพิ่ม +${packSize} ${matched.unit || 'ลัง'} เป็น ${newQty} ${matched.unit || 'ลัง'})`;
            syncStatusEl.className = 'pill-tag blue-tag';
          } else if (titleVal) {
            syncStatusEl.textContent = `✨ สร้างเป็นสต๊อกใหม่ (+${packSize} ลัง @ ฿${(amount / (packSize || 1)).toFixed(2)}/ลัง)`;
            syncStatusEl.className = 'pill-tag green-tag';
          } else {
            syncStatusEl.textContent = `พร้อมรับเข้าคลัง ${packSize} ลังอัตโนมัติ`;
            syncStatusEl.className = 'pill-tag green-tag';
          }
        } else {
          if (matched) {
            const newQty = matched.qty + packSize;
            syncStatusEl.textContent = `📦 เติมสต๊อกเดิม (ปัจจุบันมี ${matched.qty} -> เป็น ${newQty} ${matched.unit || unit})`;
            syncStatusEl.className = 'pill-tag blue-tag';
          } else if (titleVal) {
            syncStatusEl.textContent = `✨ สร้างเป็นสินค้าคงคลังใหม่ในสต๊อก (+${packSize} ${unit})`;
            syncStatusEl.className = 'pill-tag green-tag';
          } else {
            syncStatusEl.textContent = 'พร้อมซิงค์เข้าคลังอัตโนมัติ';
            syncStatusEl.className = 'pill-tag green-tag';
          }
        }
      }
      syncStatusEl.style.fontWeight = '700';
    }
  }

  setRecipeMode(mode = 'jar') {
    const isCup = mode === 'cup';
    const recModeInput = document.getElementById('recMode');
    if (recModeInput) recModeInput.value = isCup ? 'cup' : 'jar';

    const btnModeJar = document.getElementById('btnModeJar');
    const btnModeCup = document.getElementById('btnModeCup');
    const jarYieldSec = document.getElementById('recipeJarYieldSection');
    const singleCupSec = document.getElementById('recipeSingleCupSection');
    const divider = document.getElementById('recipeDivider');
    const batchTitle = document.getElementById('batchSectionTitle');
    const batchHint = document.getElementById('batchSectionHint');
    const addIngText = document.getElementById('btnAddIngredientRowText');
    const jarCostRow = document.getElementById('modalRecipeJarCostRow');
    const unitCostLabel = document.getElementById('modalRecipeUnitCostLabel');
    const totalJarProfitBox = document.getElementById('modalRecipeTotalJarProfitBox');
    const titleElem = document.getElementById('recipeModalTitle');
    const editIdInput = document.getElementById('recipeEditId');

    if (btnModeJar && btnModeCup) {
      if (isCup) {
        btnModeCup.style.background = '#ffffff';
        btnModeCup.style.color = '#10b981';
        btnModeCup.style.fontWeight = '700';
        btnModeCup.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';

        btnModeJar.style.background = 'transparent';
        btnModeJar.style.color = 'var(--text-muted)';
        btnModeJar.style.fontWeight = '600';
        btnModeJar.style.boxShadow = 'none';
      } else {
        btnModeJar.style.background = '#ffffff';
        btnModeJar.style.color = 'var(--primary)';
        btnModeJar.style.fontWeight = '700';
        btnModeJar.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';

        btnModeCup.style.background = 'transparent';
        btnModeCup.style.color = 'var(--text-muted)';
        btnModeCup.style.fontWeight = '600';
        btnModeCup.style.boxShadow = 'none';
      }
    }

    if (isCup) {
      if (titleElem && !editIdInput.value) titleElem.textContent = 'สร้างสูตรชงน้ำใหม่ (ต่อ 1 แก้ว)';
      else if (titleElem) titleElem.textContent = 'แก้ไขสูตรชงน้ำต่อ 1 แก้ว';

      if (jarYieldSec) jarYieldSec.style.display = 'none';
      if (singleCupSec) singleCupSec.style.display = 'none';
      if (divider) divider.style.display = 'none';

      if (batchTitle) batchTitle.textContent = 'รายการส่วนผสมต่อ 1 แก้ว:';
      if (batchHint) batchHint.textContent = 'ใส่วัตถุดิบและปริมาณที่ใช้ชงใน 1 แก้ว (กด 🧮 เพื่อเลือกคำนวณต้นทุนจากของที่ซื้อจริง)';
      if (addIngText) addIngText.textContent = 'เพิ่มส่วนผสมในแก้ว';

      if (jarCostRow) jarCostRow.style.display = 'none';
      if (unitCostLabel) unitCostLabel.textContent = 'ต้นทุนวัตถุดิบต่อ 1 แก้ว:';
      if (totalJarProfitBox) totalJarProfitBox.style.display = 'none';

      // อัปเดต Label และ Placeholder ของแถววัตถุดิบทั้งหมดให้เป็นโหมด 1 แก้ว
      document.querySelectorAll('#recipeIngredientsContainer .ingredient-row').forEach(row => {
        const costInput = row.querySelector('.ing-cost');
        if (costInput) costInput.placeholder = 'ทุน/แก้ว';
        const useLabel = row.querySelector('.calc-use-label');
        if (useLabel) useLabel.textContent = 'ปริมาณที่ตัดใช้ต่อแก้ว:';
      });
    } else {
      if (titleElem && !editIdInput.value) titleElem.textContent = 'สร้างสูตรชงน้ำใหม่ (ต่อ 1 โหล)';
      else if (titleElem) titleElem.textContent = 'แก้ไขสูตรชงน้ำต่อ 1 โหล';

      if (jarYieldSec) jarYieldSec.style.display = 'grid';
      if (singleCupSec) singleCupSec.style.display = 'block';
      if (divider) divider.style.display = 'block';

      if (batchTitle) batchTitle.textContent = 'รายการส่วนผสมต่อ 1 โหล/ถัง (คำนวณจากสูตร 1 แก้ว):';
      if (batchHint) batchHint.textContent = 'ดึงและคูณขยายจากสูตร 1 แก้วด้านบนให้อัตโนมัติ (สามารถกด 🧮 เพื่อผูกกับค่าใช้จ่ายที่ซื้อจริง หรือปรับแก้ได้อิสระ)';
      if (addIngText) addIngText.textContent = 'เพิ่มส่วนผสมในโหล';

      if (jarCostRow) jarCostRow.style.display = 'flex';
      if (unitCostLabel) unitCostLabel.textContent = 'ต้นทุนเฉลี่ยต่อแก้ว:';
      if (totalJarProfitBox) totalJarProfitBox.style.display = 'block';

      // อัปเดต Label และ Placeholder ของแถววัตถุดิบทั้งหมดให้เป็นโหมด 1 โหล
      document.querySelectorAll('#recipeIngredientsContainer .ingredient-row').forEach(row => {
        const costInput = row.querySelector('.ing-cost');
        if (costInput) costInput.placeholder = 'ทุน/โหล';
        const useLabel = row.querySelector('.calc-use-label');
        if (useLabel) useLabel.textContent = 'ปริมาณที่ตัดใช้ต่อโหล:';
      });
    }

    this.updateRecipeModalCalculations();
  }

  openRecipeModal(recipeId = null, initialMode = 'jar') {
    const modal = document.getElementById('recipeModal');
    const form = document.getElementById('recipeForm');
    form.reset();

    const titleElem = document.getElementById('recipeModalTitle');
    const editIdInput = document.getElementById('recipeEditId');
    const container = document.getElementById('recipeIngredientsContainer');
    container.innerHTML = '';

    const singleCupContainer = document.getElementById('singleCupContainer');
    if (singleCupContainer) singleCupContainer.innerHTML = '';

    let activeMode = initialMode || 'jar';

    if (recipeId) {
      const rec = this.data.recipes.find(r => r.id === recipeId);
      if (rec) {
        activeMode = rec.mode || (rec.yieldCups === 1 && (!rec.jarLiters || rec.jarLiters <= 0.5) ? 'cup' : 'jar');
        editIdInput.value = rec.id;
        document.getElementById('recName').value = rec.name;
        document.getElementById('recJarLiters').value = rec.jarLiters || 6;
        document.getElementById('recCupSizeOz').value = rec.cupSizeOz || 16;
        document.getElementById('recInstructions').value = rec.instructions || '';
        const priceInput = document.getElementById('recSellingPrice');
        if (priceInput) {
          priceInput.value = rec.sellingPrice !== undefined ? rec.sellingPrice : (rec.suggestedPrice || 25);
        }

        // ดึงสัดส่วน 1 แก้ว (ถ้ามี) หรือใส่เริ่มต้น
        if (rec.singleCupProportions && rec.singleCupProportions.length > 0) {
          rec.singleCupProportions.forEach(cupItem => {
            this.addSingleCupRow(cupItem.name, cupItem.amount, cupItem.unit);
          });
        } else {
          this.addSingleCupRow('น้ำชาสกัดเข้มข้น', 60, 'ml');
          this.addSingleCupRow('ผงชาไทยตรามือ', 18, 'g');
          this.addSingleCupRow('นมข้นหวาน', 1, 'oz');
          this.addSingleCupRow('นมข้นจืด', 1.5, 'oz');
          this.addSingleCupRow('นมจืด / นมสด', 1.5, 'oz');
          this.addSingleCupRow('แก้ว + ฝา + หลอด (16 oz)', 1, 'ชุด');
        }

        (rec.ingredients || []).forEach(ing => {
          this.addIngredientRowToModal(ing);
        });
      }
    } else {
      editIdInput.value = '';
      const nameInput = document.getElementById('recName');
      if (nameInput) {
        nameInput.value = '';
      }
      document.getElementById('recJarLiters').value = activeMode === 'cup' ? 0 : 6;
      document.getElementById('recCupSizeOz').value = 16;
      const yieldInput = document.getElementById('recYieldCups');
      if (yieldInput) yieldInput.value = activeMode === 'cup' ? 1 : 33;
      const priceInput = document.getElementById('recSellingPrice');
      if (priceInput) priceInput.value = '';

      if (activeMode === 'cup') {
        // สูตรต่อ 1 แก้ว (ชงสด): เริ่มต้นช่องข้อมูลว่างเปล่า ให้ผู้ใช้กรอกเอง ไม่ใส่ข้อมูลตัวอย่าง
      } else {
        // สูตรต่อ 1 โหล (ชงถัง): เริ่มต้นช่องข้อมูลว่างเปล่า ให้ผู้ใช้กรอกเอง ไม่ใส่ข้อมูลตัวอย่าง
      }
    }

    this.setRecipeMode(activeMode);
    this.calculateAutoYield();
    this.updateRecipeModalCalculations();

    // Bind mode toggle buttons
    const btnModeJar = document.getElementById('btnModeJar');
    const btnModeCup = document.getElementById('btnModeCup');
    if (btnModeJar && !btnModeJar._bound) {
      btnModeJar._bound = true;
      btnModeJar.addEventListener('click', () => this.setRecipeMode('jar'));
    }
    if (btnModeCup && !btnModeCup._bound) {
      btnModeCup._bound = true;
      btnModeCup.addEventListener('click', () => this.setRecipeMode('cup'));
    }

    const litersInput = document.getElementById('recJarLiters');
    const cupSizeSelect = document.getElementById('recCupSizeOz');
    const priceInput = document.getElementById('recSellingPrice');
    if (litersInput && !litersInput._boundYield) {
      litersInput._boundYield = true;
      litersInput.addEventListener('input', () => {
        this.calculateAutoYield();
        if (document.getElementById('recMode')?.value !== 'cup') {
          this.syncCupProportionsToBatch(false);
        }
      });
    }
    if (cupSizeSelect && !cupSizeSelect._boundYield) {
      cupSizeSelect._boundYield = true;
      cupSizeSelect.addEventListener('change', () => {
        this.calculateAutoYield();
        this.updateRecipeModalCalculations();
      });
    }
    if (priceInput && !priceInput._boundPrice) {
      priceInput._boundPrice = true;
      priceInput.addEventListener('input', () => {
        this.updateRecipeModalCalculations();
      });
    }

    modal.classList.add('active');
  }

  addSingleCupRow(name = '', amount = 1, unit = 'oz') {
    const container = document.getElementById('singleCupContainer');
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'single-cup-row';
    row.innerHTML = `
      <input type="text" class="form-input cup-ing-name" placeholder="ชื่อวัตถุดิบ 1 แก้ว" value="${this.escapeHtml(name)}" required>
      <div class="input-with-affix">
        <input type="number" class="form-input cup-ing-amount" placeholder="ปริมาณ" value="${amount}" min="0.1" step="any" required>
      </div>
      <select class="form-input cup-ing-unit">
        <option value="oz" ${unit === 'oz' ? 'selected' : ''}>ออนซ์ (oz)</option>
        <option value="ml" ${unit === 'ml' ? 'selected' : ''}>มล. (ml)</option>
        <option value="g" ${unit === 'g' ? 'selected' : ''}>กรัม (g)</option>
        <option value="ช้อนโต๊ะ" ${unit === 'ช้อนโต๊ะ' ? 'selected' : ''}>ช้อนโต๊ะ (tbsp)</option>
        <option value="ชุด" ${unit === 'ชุด' ? 'selected' : ''}>ชุด (แก้ว/ฝา)</option>
        <option value="ชิ้น" ${unit === 'ชิ้น' ? 'selected' : ''}>ชิ้น/หน่วย</option>
      </select>
      <button type="button" class="btn-icon-danger" title="ลบรายการนี้">&times;</button>
    `;

    row.querySelector('.btn-icon-danger').addEventListener('click', () => {
      row.remove();
    });

    row.querySelectorAll('input, select').forEach(input => {
      input.addEventListener('change', () => {
        this.syncCupProportionsToBatch(false);
      });
    });

    container.appendChild(row);
  }

  syncCupProportionsToBatch(showNotification = true) {
    const cupRows = document.querySelectorAll('#singleCupContainer .single-cup-row');
    if (cupRows.length === 0) return;

    const jarLiters = parseFloat(document.getElementById('recJarLiters')?.value) || 6;
    const batchContainer = document.getElementById('recipeIngredientsContainer');
    if (!batchContainer) return;

    // จำค่า expenseId และ calcData เดิมของแถวในโหล เพื่อไม่ให้สิ่งที่ผู้ใช้เคยเลือกหลุดหาย
    const existingRowStates = {};
    batchContainer.querySelectorAll('.ingredient-row').forEach(row => {
      const n = (row.querySelector('.ing-name')?.value || '').trim().toLowerCase();
      const expSelect = row.querySelector('.calc-expense-select');
      const packPrice = parseFloat(row.querySelector('.calc-pack-price')?.value) || 0;
      const packSize = parseFloat(row.querySelector('.calc-pack-size')?.value) || 0;
      const packUnit = row.querySelector('.calc-pack-unit')?.value || '';
      const useAmount = parseFloat(row.querySelector('.calc-use-amount')?.value) || 0;
      const selectedExpId = expSelect?.value || '';

      if (n) {
        existingRowStates[n] = {
          selectedExpId,
          calcData: packPrice > 0 ? { packPrice, packSize, packUnit, useAmount } : null
        };
      }
    });

    // เคลียร์และสร้างรายการส่วนผสมต่อ 1 โหลใหม่
    batchContainer.innerHTML = '';

    // 1. คำนวณปริมาตรของเหลวรวมต่อ 1 แก้วจริง
    // ของเหลว = น้ำชา/กาแฟ/น้ำสกัด + นมข้นหวาน + นมข้นจืด + นมสด + ไซรัป/น้ำเชื่อม (oz * 29.57 หรือ ml)
    let singleCupLiquidMl = 0;
    let singleCupMilkOz = 0;
    let hasTeaShotItem = false;
    let hasTeaPowderItem = false;

    cupRows.forEach(row => {
      const name = (row.querySelector('.cup-ing-name')?.value || '').toLowerCase();
      const amount = parseFloat(row.querySelector('.cup-ing-amount')?.value) || 0;
      const unit = row.querySelector('.cup-ing-unit')?.value || '';

      if (name.includes('แก้ว') || name.includes('ฝา') || name.includes('หลอด') || unit === 'ชุด' || unit === 'ชิ้น' || unit === 'ใบ') {
        return; // บรรจุภัณฑ์ไม่นำมาคิดเป็นของเหลว
      }

      if (unit === 'ml') {
        singleCupLiquidMl += amount;
        if (name.includes('ชา') || name.includes('น้ำสกัด') || name.includes('กาแฟ') || name.includes('ช็อต')) {
          hasTeaShotItem = true;
        }
      } else if (unit === 'oz') {
        const ml = amount * 29.57;
        singleCupLiquidMl += ml;
        if (name.includes('นม') || name.includes('หวาน') || name.includes('เชื่อม') || name.includes('ไซรัป')) {
          singleCupMilkOz += amount;
        }
      } else if (unit === 'g') {
        if (name.includes('ชา') || name.includes('กาแฟ') || name.includes('โกโก้')) {
          hasTeaPowderItem = true;
        }
      }
    });

    // หากในสูตรมีผงชาแต่ไม่มีแถวน้ำชาสกัด (ml) ให้เพิ่มน้ำชาสกัดมาตรฐาน 60 ml อัตโนมัติ เพื่อให้ของเหลวสมบูรณ์
    if (hasTeaPowderItem && !hasTeaShotItem) {
      singleCupLiquidMl += 60;
    }

    // หากรวมของเหลวแล้วยังน้อยเกินไป ให้ใช้ค่ามาตรฐานแก้ว 16 oz = 180 ml
    if (singleCupLiquidMl < 50) {
      singleCupLiquidMl = 180;
    }

    // 2. ตัวคูณขยายสูตรลงถัง (Batch Multiplier) ยึดตามปริมาตรโหลจริงเสมอ (เช่น ถัง 6L = 6,000 ml / 180 ml ≈ 33.33 แก้ว)
    const batchScaleMultiplier = Math.round(((jarLiters * 1000) / singleCupLiquidMl) * 10) / 10;
    const yieldCups = this.calculateAutoYield();

    // 3. วนลูปสร้างแถวส่วนผสมของโหลจากสัดส่วน 1 แก้ว
    cupRows.forEach(row => {
      const name = row.querySelector('.cup-ing-name')?.value.trim();
      const amountPerCup = parseFloat(row.querySelector('.cup-ing-amount')?.value) || 0;
      const unit = row.querySelector('.cup-ing-unit')?.value || 'oz';

      if (!name || amountPerCup <= 0) return;

      const lowerName = name.toLowerCase();

      // ถ้ารายการคือน้ำชาสกัด ไม่ต้องใส่ซ้ำเป็นวัตถุดิบซื้อ เพราะต้องสกัดจากผงชา + น้ำร้อน
      if (lowerName.includes('น้ำชาสกัด') || lowerName.includes('ช็อตชา') || lowerName.includes('น้ำชาเข้มข้น')) {
        return;
      }

      // บรรจุภัณฑ์คิดตามจำนวนแก้วที่เสิร์ฟ (yieldCups)
      // วัตถุดิบผสมในถังทั้งหมด ขยายตาม batchScaleMultiplier คงที่
      const isPackaging = lowerName.includes('แก้ว') || lowerName.includes('ฝา') || lowerName.includes('หลอด') || unit === 'ชุด' || unit === 'ใบ';
      const scale = isPackaging ? yieldCups : batchScaleMultiplier;
      const recipeAmountVal = Math.round((amountPerCup * scale) * 10) / 10;

      // พยายามหาในบันทึก expenses ว่ามีของชิ้นนี้ไหม
      let matchedExp = null;
      const prevSaved = existingRowStates[lowerName];

      if (prevSaved?.selectedExpId && this.data.expenses) {
        matchedExp = this.data.expenses.find(e => e.id === prevSaved.selectedExpId);
      }
      if (!matchedExp && this.data.expenses) {
        matchedExp = this.data.expenses.find(e => {
          const t = (e.title || '').toLowerCase();
          return t.includes(lowerName) || lowerName.includes(t.split(' ')[0]);
        });
      }

      let cost = 0;
      let displayAmount = `${recipeAmountVal} ${unit}`;
      let calcData = null;

      if (matchedExp) {
        const packPrice = Number(matchedExp.amount) || 0;
        let packSize = Number(matchedExp.packSize) || 0;
        let packUnit = matchedExp.packUnit || '';

        if (!packSize || packSize <= 0) {
          const qty = `${matchedExp.qtyDesc || ''} ${matchedExp.title || ''}`;
          const mlM = qty.match(/(\d+(\.\d+)?)\s*(ml|มล|มิลลิลิตร)/i);
          const lM = qty.match(/(\d+(\.\d+)?)\s*(l|liter|ลิตร)/i);
          const gM = qty.match(/(\d+(\.\d+)?)\s*(g|กรัม)/i);
          const kgM = qty.match(/(\d+(\.\d+)?)\s*(kg|กก)/i);
          const canM = qty.match(/(\d+(\.\d+)?)\s*(กป|กระป๋อง)/i);
          const numM = qty.match(/(\d+(\.\d+)?)/);

          if (mlM) {
            packSize = parseFloat(mlM[1]);
            packUnit = 'ml';
          } else if (lM) {
            packSize = parseFloat(lM[1]);
            packUnit = 'ลิตร';
          } else if (gM) {
            packSize = parseFloat(gM[1]);
            packUnit = 'g';
          } else if (kgM) {
            packSize = parseFloat(kgM[1]) * 1000;
            packUnit = 'g';
          } else if (canM) {
            packSize = parseFloat(canM[1]);
            packUnit = 'กระป๋อง';
          } else if (numM) {
            packSize = parseFloat(numM[1]);
            packUnit = qty.replace(numM[1], '').trim() || unit;
          } else {
            packSize = 1;
            packUnit = unit;
          }
        }

        // คำนวณปริมาณใช้ในหน่วยแพ็กที่ซื้อมา (useInPackUnit) โดยรักษาหน่วยของสูตรเดิมไว้
        let useInPackUnit = recipeAmountVal;

        if (unit === 'g' && (packUnit === 'g' || packUnit === 'กรัม')) {
          useInPackUnit = recipeAmountVal;
          displayAmount = `${recipeAmountVal} กรัม`;
        } else if (unit === 'g' && (packUnit === 'kg' || packUnit === 'กก')) {
          useInPackUnit = Math.round((recipeAmountVal / 1000) * 100) / 100;
          displayAmount = `${recipeAmountVal} กรัม (~${useInPackUnit} kg)`;
        } else if (unit === 'oz' && (packUnit === 'ml' || packUnit === 'มล')) {
          // แปลงจาก oz เป็น ml (1 oz = 29.57 ml)
          useInPackUnit = Math.round(recipeAmountVal * 29.57 * 10) / 10;
          displayAmount = `${recipeAmountVal} oz (~${useInPackUnit} ml)`;
        } else if (unit === 'oz' && (packUnit === 'ลิตร' || packUnit === 'l' || packUnit === 'liter')) {
          // แปลงจาก oz เป็น ลิตร
          useInPackUnit = Math.round(((recipeAmountVal * 29.57) / 1000) * 100) / 100;
          displayAmount = `${recipeAmountVal} oz (~${useInPackUnit} ลิตร)`;
        } else if (unit === 'oz' && (packUnit.includes('กป') || packUnit.includes('กระป๋อง'))) {
          // นม 1 กระป๋องมาตรฐาน ~13 oz (~388g)
          useInPackUnit = Math.round((recipeAmountVal / 13) * 10) / 10;
          displayAmount = `${recipeAmountVal} oz (~${useInPackUnit} กระป๋อง)`;
        } else if (unit === 'oz' && (packUnit === 'g' || packUnit === 'กรัม')) {
          // นมข้นหวาน 1 oz ~ 38.8g, นมจืด 1 oz ~ 31g
          const gPerOz = lowerName.includes('หวาน') ? 38.8 : 31;
          useInPackUnit = Math.round(recipeAmountVal * gPerOz);
          displayAmount = `${recipeAmountVal} oz (~${useInPackUnit} กรัม)`;
        } else if (unit === 'oz' && (packUnit === 'kg' || packUnit === 'กก')) {
          // แปลงจาก oz เป็น kg: 1 oz นมข้นหวาน ~38.8g = 0.0388 kg
          const gPerOz = lowerName.includes('หวาน') ? 38.8 : 31;
          useInPackUnit = Math.round(((recipeAmountVal * gPerOz) / 1000) * 100) / 100;
          displayAmount = `${recipeAmountVal} oz (~${useInPackUnit} kg)`;
        } else if (unit === 'ml' && (packUnit === 'ml' || packUnit === 'มล')) {
          useInPackUnit = recipeAmountVal;
          displayAmount = `${recipeAmountVal} ml`;
        } else if (unit === 'ml' && (packUnit === 'ลิตร' || packUnit === 'l' || packUnit === 'liter')) {
          useInPackUnit = Math.round((recipeAmountVal / 1000) * 100) / 100;
          displayAmount = `${recipeAmountVal} ml (~${useInPackUnit} ลิตร)`;
        } else if (isPackaging) {
          useInPackUnit = recipeAmountVal;
          displayAmount = `${recipeAmountVal} ${packUnit || 'ชุด'}`;
        } else {
          useInPackUnit = recipeAmountVal;
          displayAmount = `${recipeAmountVal} ${unit}`;
        }

        cost = Math.round(((packPrice / (packSize || 1)) * useInPackUnit) * 100) / 100;
        calcData = {
          expenseId: matchedExp.id,
          packPrice,
          packSize,
          packUnit,
          useAmount: useInPackUnit,
          originalAmountVal: recipeAmountVal,
          originalUnit: unit
        };
      } else {
        const isWaterOrFree = lowerName.includes('น้ำร้อน') || lowerName.includes('น้ำเปล่า') ||
          lowerName.includes('น้ำสะอาด') || lowerName.includes('น้ำต้ม') ||
          lowerName.includes('น้ำกรอง') || lowerName === 'น้ำ';

        if (isWaterOrFree) {
          cost = 0;
        } else if (unit === 'oz') {
          cost = Math.round(recipeAmountVal * 2.2);
        } else if (unit === 'g') {
          cost = Math.round(recipeAmountVal * 0.2);
        } else if (unit === 'ml') {
          cost = Math.round((recipeAmountVal / 1000) * 15 * 100) / 100; // ml คิดเฉลี่ยลิตรละ ~15 บาท (~0.015/ml)
        } else if (unit === 'ชุด') {
          cost = Math.round(recipeAmountVal * 1.5);
        } else {
          cost = Math.round(recipeAmountVal * 2);
        }
      }

      this.addIngredientRowToModal({
        name,
        amount: displayAmount,
        cost,
        calcData
      });
    });

    this.updateRecipeModalCalculations();
    if (showNotification) {
      const priceInput = document.getElementById('recSellingPrice');
      const sellingPrice = priceInput ? (parseFloat(priceInput.value) || 0) : 25;
      const costInputs = document.querySelectorAll('#recipeIngredientsContainer .ing-cost');
      let totalCost = 0;
      costInputs.forEach(input => { totalCost += parseFloat(input.value) || 0; });
      const currentUnitCost = yieldCups > 0 ? (totalCost / yieldCups) : 0;
      const profitPerCup = sellingPrice - currentUnitCost;

      if (profitPerCup < 5.0 && sellingPrice > 0) {
        this.showToast(`⚠️ ขยายสูตรแล้วได้กำไร ฿${profitPerCup.toFixed(2)}/แก้ว (น้อยกว่า 5 บาท) ระบบได้คำนวณสูตรปรับกำไร 5 บาทไว้ให้ด้านล่าง`, 'warning');
      } else {
        this.showToast(`คำนวณขยายสูตรสำหรับถัง ${jarLiters} ลิตร (${batchScaleMultiplier} เท่า) เรียบร้อยแล้ว`, 'success');
      }
    }
  }

  calculateAutoYield() {
    const liters = parseFloat(document.getElementById('recJarLiters')?.value) || 6;
    const cupOz = parseInt(document.getElementById('recCupSizeOz')?.value) || 16;

    // คำนวณปริมาณของเหลวรวมต่อแก้วเมื่อใส่น้ำแข็งเต็มแก้ว (แก้ว 16 oz: น้ำชาสกัด 60 ml + นม/น้ำเชื่อม 120 ml = 180 ml)
    const liquidPerCupMap = {
      10: 110, // ชา ~38 ml + นม ~72 ml
      12: 135, // ชา ~45 ml + นม ~90 ml
      16: 180, // ชา 60 ml + นม 4 oz (120 ml)
      20: 210, // ชา ~70 ml + นม ~140 ml
      22: 240, // ชา ~80 ml + นม ~160 ml
      32: 350  // ชา ~120 ml + นม ~230 ml
    };

    const mlPerCup = liquidPerCupMap[cupOz] || (cupOz * 11.25);
    const totalMl = liters * 1000;
    const calculatedCups = Math.max(1, Math.round(totalMl / mlPerCup));

    const yieldInput = document.getElementById('recYieldCups');
    const jarCapacityInput = document.getElementById('recJarCapacity');
    const hintText = document.getElementById('recYieldHintText');
    const scaleBadge = document.getElementById('cupScaleCountBadge');

    if (yieldInput) yieldInput.value = calculatedCups;
    if (scaleBadge) scaleBadge.textContent = calculatedCups;
    if (jarCapacityInput) {
      jarCapacityInput.value = `โหล/ถัง ${liters} ลิตร (แก้ว ${cupOz} oz ได้ ~${calculatedCups} แก้ว)`;
    }
    if (hintText) {
      const teaShotPerCup = Math.round(60 * (cupOz / 16));
      hintText.textContent = `น้ำชาปรุงสำเร็จ ${liters} ลิตร (${totalMl.toLocaleString()} ml) เสิร์ฟแก้ว ${cupOz} oz + น้ำแข็งเต็มแก้ว (น้ำชาช็อต ~${teaShotPerCup} ml, ของเหลวรวม ${mlPerCup} ml) ได้ ~${calculatedCups} แก้ว`;
    }

    return calculatedCups;
  }

  addIngredientRowToModal(ingData = {}) {
    const container = document.getElementById('recipeIngredientsContainer');
    if (!container) return;

    let name = '';
    let amount = '';
    let cost = '';
    let calcData = null;

    if (typeof ingData === 'string') {
      name = ingData;
      amount = arguments[1] || '';
      cost = arguments[2] || '';
    } else if (typeof ingData === 'object' && ingData !== null) {
      name = ingData.name || '';
      amount = ingData.amount || '';
      cost = ingData.cost !== undefined && ingData.cost !== null ? ingData.cost : '';
      calcData = ingData.calcData || null;
    }

    let amountVal = '';
    let amountUnit = 'oz';

    // ดึงตัวเลขและหน่วยคงที่ออกจาก amount หรือ calcData
    if (calcData && calcData.originalUnit) {
      amountUnit = calcData.originalUnit;
      amountVal = calcData.originalAmountVal !== undefined ? calcData.originalAmountVal : '';
    }

    if (!amountVal && amount) {
      const parsedMatch = String(amount).match(/^([\d,.]+)\s*([a-zA-Zก-๙]+)?/);
      if (parsedMatch) {
        amountVal = parsedMatch[1].replace(/,/g, '');
        if (parsedMatch[2]) {
          amountUnit = parsedMatch[2];
        }
      } else {
        amountVal = amount;
      }
    }

    if (!amountUnit) {
      amountUnit = 'oz';
    }

    const row = document.createElement('div');
    row.className = 'ingredient-row';

    let pPrice = calcData ? (calcData.packPrice || '') : '';
    let pSize = calcData ? (calcData.packSize || '') : '';
    let pUnit = calcData ? (calcData.packUnit || 'กรัม') : 'กรัม';
    let pUse = calcData ? (calcData.useAmount || '') : '';
    let selectedExpId = calcData ? (calcData.expenseId || '') : '';

    // หากไม่มี selectedExpId โดยตรง แต่มีชื่อวัตถุดิบ ให้ลองค้นหา expense ที่ตรงกันเป็น fallback
    if (!selectedExpId && name && this.data.expenses) {
      const lowerRowName = name.toLowerCase();
      const matched = this.data.expenses.find(e => {
        const t = (e.title || '').toLowerCase();
        return t.includes(lowerRowName) || lowerRowName.includes(t.split(' ')[0]) || (pPrice > 0 && Math.abs(Number(e.amount) - pPrice) < 0.1);
      });
      if (matched) {
        selectedExpId = matched.id;
      }
    }

    // ซิงค์ราคาและขนาดแพ็กล่าสุดจาก expense ทันที โดยไม่ต้องกดปุ่มคำนวณซ้ำ
    if (selectedExpId && this.data.expenses) {
      const latestExp = this.data.expenses.find(e => e.id === selectedExpId);
      if (latestExp && latestExp.amount !== undefined) {
        pPrice = parseFloat(latestExp.amount) || 0;
        if (latestExp.packSize) pSize = parseFloat(latestExp.packSize) || pSize;
        if (latestExp.packUnit) pUnit = latestExp.packUnit;
        if (pUse > 0 && pPrice > 0 && pSize > 0) {
          cost = Math.round(((pPrice / pSize) * pUse) * 100) / 100;
        }
      }
    }

    const hasCalc = (pPrice !== '' && pPrice > 0) || (pSize !== '' && pSize > 0) || Boolean(calcData);
    const isCupMode = document.getElementById('recMode')?.value === 'cup';

    row.innerHTML = `
      <div class="ingredient-row-main">
        <input type="text" class="form-input ing-name" placeholder="ชื่อวัตถุดิบ (เช่น ผงชาไทย, แก้ว+ฝา)" value="${this.escapeHtml(name)}" required>
        <div style="display:flex; gap:0.35rem; align-items:center;">
          <div class="input-with-affix" style="flex:1; min-width:110px;">
            <input type="number" step="any" min="0" class="form-input ing-amount" placeholder="ปริมาณ" value="${this.escapeHtml(String(amountVal))}" style="padding-left:0.6rem; padding-right:2.4rem; font-weight:600; color:var(--text-main);">
            <span class="affix-right ing-amount-unit-label" style="font-size:0.8rem; font-weight:700; color:var(--primary); pointer-events:none; right:0.5rem;">${this.escapeHtml(amountUnit)}</span>
          </div>
          <input type="hidden" class="ing-amount-unit" value="${this.escapeHtml(amountUnit)}">
          <button type="button" class="ingredient-calc-toggle-btn ${hasCalc ? 'active' : ''}" title="คำนวณจากราคาแพ็กจริง">
            <span>🧮 แพ็ก</span>
          </button>
        </div>
        <div class="input-with-affix">
          <span class="affix-left">฿</span>
          <input type="number" class="form-input ing-cost" placeholder="${isCupMode ? 'ทุน/แก้ว' : 'ทุน/โหล'}" value="${cost !== '' ? Number(cost).toFixed(2) : ''}" min="0" step="0.01" required>
        </div>
        <button type="button" class="btn-icon-danger" title="ลบรายการนี้">&times;</button>
      </div>

      <!-- Expandable Expense Link Panel -->
      <div class="ingredient-calc-panel ${hasCalc ? 'show' : ''}">
        <div style="display:grid; grid-template-columns: 2.8fr 1.2fr; gap:0.6rem; align-items:flex-end;">
          <div style="min-width:0;">
            <label style="font-size:0.75rem; font-weight:700; color:var(--primary); display:block; margin-bottom:0.25rem;">
              📦 เลือกจากบันทึกค่าใช้จ่าย & วัตถุดิบ:
            </label>
            <select class="form-input calc-expense-select" style="font-size:0.85rem; height:38px; padding:0.35rem 0.6rem; background:#ffffff; width:100%; text-overflow:ellipsis;" title="เลือกวัตถุดิบที่บันทึกไว้">
              <option value="">-- เลือกวัตถุดิบที่บันทึกไว้ --</option>
              ${(this.data.expenses || []).map(exp => {
      const s = exp.packSize || '';
      const u = exp.packUnit || '';
      const isSelected = selectedExpId && selectedExpId === exp.id ? 'selected' : '';
      return `<option value="${exp.id}" ${isSelected}
                  data-title="${this.escapeHtml(exp.title)}" 
                  data-amount="${exp.amount}" 
                  data-qty="${this.escapeHtml(exp.qtyDesc || '')}" 
                  data-packsize="${s}" 
                  data-packunit="${this.escapeHtml(u)}" 
                  data-note="${this.escapeHtml(exp.note || '')}">
                  ${this.escapeHtml(exp.title)} (฿${exp.amount}${s ? ` / ${s} ${u}` : (exp.qtyDesc ? ` / ${this.escapeHtml(exp.qtyDesc)}` : '')})
                </option>`;
    }).join('')}
            </select>
          </div>
          <div style="min-width:0;">
            <label class="calc-use-label" style="font-size:0.75rem; font-weight:700; color:var(--text-main); display:block; margin-bottom:0.25rem;">
              ${isCupMode ? 'ปริมาณที่ตัดใช้ต่อแก้ว:' : 'ปริมาณที่ตัดใช้ต่อโหล:'}
            </label>
            <div class="input-with-affix" style="width:100%;">
              <input type="number" class="form-input calc-use-amount" placeholder="เช่น 1 หรือ 20" value="${pUse}" min="0" step="any" style="height:38px; padding-left:0.6rem; padding-right:2.4rem; font-weight:600;">
              <span class="affix-right calc-unit-label" style="font-size:0.75rem; font-weight:600; color:var(--primary); right:0.5rem; pointer-events:none;">${this.escapeHtml(pUnit || 'หน่วย')}</span>
            </div>
          </div>
        </div>

        <input type="hidden" class="calc-pack-price" value="${pPrice}">
        <input type="hidden" class="calc-pack-size" value="${pSize}">
        <input type="hidden" class="calc-pack-unit" value="${this.escapeHtml(pUnit)}">

        <div class="calc-summary-badge calc-badge-text" style="margin-top:0.5rem; width:100%; box-sizing:border-box;">
          ${hasCalc && pPrice > 0 ? `💡 ซื้อมา ฿${pPrice} (${pSize} ${pUnit}) | คำนวณตัดใช้ ${pUse} ${pUnit} = ต้นทุน ฿${cost !== '' ? Number(cost).toFixed(2) : '0.00'}` : (isCupMode ? '💡 เลือกวัตถุดิบ ระบบจะคำนวณต้นทุนจาก 1 แก้วให้อัตโนมัติ (แก้ไขตัวเลขได้ตามต้องการ)' : '💡 เลือกวัตถุดิบ ระบบจะคำนวณสัดส่วนจาก 1 แก้วขยายเป็นทั้งโหลให้อัตโนมัติ (แก้ไขตัวเลขได้ตามต้องการ)')}
        </div>
      </div>
    `;

    const toggleBtn = row.querySelector('.ingredient-calc-toggle-btn');
    const calcPanel = row.querySelector('.ingredient-calc-panel');
    const costInput = row.querySelector('.ing-cost');
    const nameInput = row.querySelector('.ing-name');
    const amountInput = row.querySelector('.ing-amount');
    const amountUnitInput = row.querySelector('.ing-amount-unit');
    const amountUnitLabel = row.querySelector('.ing-amount-unit-label');
    const expenseSelect = row.querySelector('.calc-expense-select');
    const packPriceInput = row.querySelector('.calc-pack-price');
    const packSizeInput = row.querySelector('.calc-pack-size');
    const packUnitInput = row.querySelector('.calc-pack-unit');
    const unitLabel = row.querySelector('.calc-unit-label');
    const useAmountInput = row.querySelector('.calc-use-amount');
    const badgeText = row.querySelector('.calc-badge-text');

    toggleBtn.addEventListener('click', () => {
      calcPanel.classList.toggle('show');
      toggleBtn.classList.toggle('active', calcPanel.classList.contains('show'));
    });

    const setFixedUnit = (newUnit) => {
      if (newUnit) {
        amountUnit = newUnit;
        if (amountUnitInput) amountUnitInput.value = newUnit;
        if (amountUnitLabel) amountUnitLabel.textContent = newUnit;
      }
    };

    const runPackCalc = () => {
      const price = parseFloat(packPriceInput.value) || 0;
      const size = parseFloat(packSizeInput.value) || 1;
      const use = parseFloat(useAmountInput.value) || 0;
      const unit = packUnitInput.value.trim() || 'หน่วย';
      if (unitLabel) unitLabel.textContent = unit;

      if (price > 0 && size > 0 && use > 0) {
        const calculatedCost = Math.round(((price / size) * use) * 100) / 100;
        costInput.value = calculatedCost;

        // ถ้าช่อง amountInput ยังไม่มีค่า ให้ใส่ตัวเลข use และตั้งหน่วยคงที่
        if (!amountInput.value) {
          amountInput.value = use;
          setFixedUnit(unit);
        }

        badgeText.textContent = `💡 ซื้อมา ฿${price} (${size} ${unit}) | ใช้ ${use} ${unit} = ต้นทุน ฿${calculatedCost.toFixed(2)}`;
        badgeText.style.color = 'var(--primary)';
        toggleBtn.classList.add('active');
      } else if (price > 0) {
        badgeText.textContent = `💡 บันทึกราคา ฿${price} (${size} ${unit}) ใส่จำนวนที่ใช้เพื่อคำนวณ`;
        badgeText.style.color = 'var(--text-muted)';
      }
      this.updateRecipeModalCalculations();
    };

    // Auto-fill from expense selection
    if (expenseSelect) {
      expenseSelect.addEventListener('change', (e) => {
        const opt = e.target.selectedOptions[0];
        if (!opt || !opt.value) return;

        const title = opt.getAttribute('data-title') || '';
        const amount = parseFloat(opt.getAttribute('data-amount')) || 0;
        const qty = opt.getAttribute('data-qty') || '';
        let explicitSize = parseFloat(opt.getAttribute('data-packsize'));
        let explicitUnit = opt.getAttribute('data-packunit') || '';

        // ถ้าช่องชื่อว่าง ให้กรอกชื่อวัตถุดิบ (ตัดวงเล็บด้านหลังออก)
        if (!nameInput.value.trim()) {
          nameInput.value = title.split('(')[0].trim();
        }

        // กรอกราคาแพ็ก
        packPriceInput.value = amount;

        // แยกตัวเลขขนาดและหน่วยจากบันทึก เช่น 400g, 48 กป., 1000 ใบ
        let parsedSize = explicitSize > 0 ? explicitSize : 0;
        let parsedUnit = explicitUnit || '';

        if (!parsedSize || parsedSize <= 0) {
          const textToParse = `${qty} ${title}`;
          const mlM = textToParse.match(/(\d+(\.\d+)?)\s*(ml|มล|มิลลิลิตร)/i);
          const lM = textToParse.match(/(\d+(\.\d+)?)\s*(l|liter|ลิตร)/i);
          const gM = textToParse.match(/(\d+(\.\d+)?)\s*(g|กรัม)/i);
          const kgM = textToParse.match(/(\d+(\.\d+)?)\s*(kg|กก)/i);
          const canM = textToParse.match(/(\d+(\.\d+)?)\s*(กป|กระป๋อง)/i);
          const cupM = textToParse.match(/(\d+(\.\d+)?)\s*(ชุด|ใบ|แก้ว)/i);
          const anyNum = textToParse.match(/(\d+(\.\d+)?)/);

          if (mlM) {
            parsedSize = parseFloat(mlM[1]);
            parsedUnit = 'ml';
          } else if (lM) {
            parsedSize = parseFloat(lM[1]);
            parsedUnit = 'ลิตร';
          } else if (gM) {
            parsedSize = parseFloat(gM[1]);
            parsedUnit = 'g';
          } else if (kgM) {
            parsedSize = parseFloat(kgM[1]) * 1000;
            parsedUnit = 'g';
          } else if (canM) {
            parsedSize = parseFloat(canM[1]);
            parsedUnit = 'กระป๋อง';
          } else if (cupM) {
            parsedSize = parseFloat(cupM[1]);
            parsedUnit = 'ชุด';
          } else if (anyNum) {
            parsedSize = parseFloat(anyNum[1]);
            parsedUnit = qty.replace(anyNum[1], '').trim() || 'หน่วย';
          } else {
            parsedSize = 1;
            parsedUnit = 'หน่วย';
          }
        }

        packSizeInput.value = parsedSize;
        packUnitInput.value = parsedUnit;
        if (unitLabel) unitLabel.textContent = parsedUnit;

        const isCurrentlyCupMode = document.getElementById('recMode')?.value === 'cup';

        // ดึงข้อมูลการชงของ 1 แก้วเพื่อนำมาคำนวณสัดส่วนขยาย
        const jarLiters = parseFloat(document.getElementById('recJarLiters')?.value) || 6;
        const totalYieldCups = parseInt(document.getElementById('recYieldCups')?.value) || 33;
        const lowerTitle = title.toLowerCase();
        const rowName = nameInput.value.toLowerCase();

        // ค้นหาแถว 1 แก้วที่ตรงกับวัตถุดิบนี้ เพื่อเอาตัวเลขมาขยายตรงๆ
        const cupRows = document.querySelectorAll('#singleCupContainer .single-cup-row');
        let matchedCupAmount = 0;
        let matchedCupUnit = '';

        cupRows.forEach(cRow => {
          const cName = (cRow.querySelector('.cup-ing-name')?.value || '').toLowerCase();
          if (cName && (cName.includes(rowName) || rowName.includes(cName) || lowerTitle.includes(cName) || cName.includes(lowerTitle.split(' ')[0]))) {
            matchedCupAmount = parseFloat(cRow.querySelector('.cup-ing-amount')?.value) || 0;
            matchedCupUnit = cRow.querySelector('.cup-ing-unit')?.value || '';
          }
        });

        // คำนวณตัวคูณสเกลโหล (ยึดตามลิตรของถังเป็นหลัก)
        let singleCupLiquidMl = 0;
        let hasTeaPowderInCup = false;
        let hasTeaShotInCup = false;
        cupRows.forEach(cRow => {
          const cn = (cRow.querySelector('.cup-ing-name')?.value || '').toLowerCase();
          const ca = parseFloat(cRow.querySelector('.cup-ing-amount')?.value) || 0;
          const cu = cRow.querySelector('.cup-ing-unit')?.value || '';
          if (!cn.includes('แก้ว') && !cn.includes('ฝา') && !cn.includes('หลอด') && cu !== 'ชุด' && cu !== 'ชิ้น') {
            if (cu === 'ml') {
              singleCupLiquidMl += ca;
              if (cn.includes('ชา') || cn.includes('น้ำสกัด') || cn.includes('กาแฟ') || cn.includes('ช็อต')) {
                hasTeaShotInCup = true;
              }
            } else if (cu === 'oz') {
              singleCupLiquidMl += (ca * 29.57);
            } else if (cu === 'g') {
              if (cn.includes('ชา') || cn.includes('กาแฟ') || cn.includes('โกโก้')) {
                hasTeaPowderInCup = true;
              }
            }
          }
        });
        // ถ้ามีผงชา (เช่น 18g) แต่ยังไม่ได้ระบุน้ำชาสกัดแยกแถว ให้นับน้ำชาสกัดมาตรฐาน 60 ml
        if (hasTeaPowderInCup && !hasTeaShotInCup) {
          singleCupLiquidMl += 60;
        }
        if (singleCupLiquidMl < 50) singleCupLiquidMl = 180;
        const batchScale = isCurrentlyCupMode ? 1 : Math.round(((jarLiters * 1000) / singleCupLiquidMl) * 10) / 10;

        let autoUse = 1;

        if (lowerTitle.includes('แก้ว') || lowerTitle.includes('ฝา') || lowerTitle.includes('หลอด') || parsedUnit.includes('ใบ') || parsedUnit.includes('ชุด')) {
          // บรรจุภัณฑ์ แก้ว/ฝา/หลอด: ใช้ตามจำนวนแก้วที่เสิร์ฟจริง (ถ้า 1 แก้ว คือ 1 ชุด)
          autoUse = isCurrentlyCupMode ? 1 : totalYieldCups;
          amountInput.value = autoUse;
          setFixedUnit('ชุด');
        } else if (matchedCupAmount > 0 && matchedCupUnit === 'oz') {
          // ถ้ามีสูตร 1 แก้วระบุ oz (เช่น นมสด 1.5 oz, นมข้นหวาน 1 oz, นมข้นจืด 1.5 oz)
          const ozTotal = Math.round((matchedCupAmount * batchScale) * 10) / 10;
          amountInput.value = ozTotal;
          setFixedUnit('oz');

          if (parsedUnit === 'ml' || parsedUnit === 'มล') {
            autoUse = Math.round(ozTotal * 29.57 * 10) / 10;
          } else if (parsedUnit === 'ลิตร' || parsedUnit === 'l' || parsedUnit === 'liter') {
            autoUse = Math.round(((ozTotal * 29.57) / 1000) * 100) / 100;
          } else if (parsedUnit.includes('กป') || parsedUnit.includes('กระป๋อง')) {
            autoUse = Math.round((ozTotal / 13) * 10) / 10;
          } else if (parsedUnit === 'g' || parsedUnit === 'กรัม') {
            const gPerOz = (lowerTitle.includes('หวาน') || rowName.includes('หวาน')) ? 38.8 : 31;
            autoUse = Math.round(ozTotal * gPerOz);
          } else if (parsedUnit === 'kg' || parsedUnit === 'กก') {
            const gPerOz = (lowerTitle.includes('หวาน') || rowName.includes('หวาน')) ? 38.8 : 31;
            autoUse = Math.round(((ozTotal * gPerOz) / 1000) * 100) / 100;
          } else {
            autoUse = ozTotal;
          }
        } else if (matchedCupAmount > 0 && (matchedCupUnit === 'ml' || matchedCupUnit === 'มล')) {
          const mlTotal = Math.round((matchedCupAmount * batchScale) * 10) / 10;
          amountInput.value = mlTotal;
          setFixedUnit('ml');

          if (parsedUnit === 'ml' || parsedUnit === 'มล') {
            autoUse = mlTotal;
          } else if (parsedUnit === 'ลิตร' || parsedUnit === 'l' || parsedUnit === 'liter') {
            autoUse = Math.round((mlTotal / 1000) * 100) / 100;
          } else {
            autoUse = mlTotal;
          }
        } else if (matchedCupAmount > 0 && matchedCupUnit === 'g') {
          // ถ้ามีสูตร 1 แก้วระบุ g (เช่น ผงชาไทย 18g)
          const gTotal = Math.round(matchedCupAmount * batchScale);
          amountInput.value = gTotal;
          setFixedUnit('g');

          if (parsedUnit === 'g' || parsedUnit === 'กรัม') {
            autoUse = gTotal;
          } else if (parsedUnit === 'kg' || parsedUnit === 'กก') {
            autoUse = Math.round((gTotal / 1000) * 100) / 100;
          } else if (parsedUnit.includes('ถุง') || parsedUnit.includes('ห่อ')) {
            autoUse = Math.round((gTotal / (parsedSize > 10 ? parsedSize : 400)) * 10) / 10;
          } else {
            autoUse = gTotal;
          }
        } else {
          // ถ้าไม่พบการจับคู่กับ 1 แก้วโดยตรง ให้ใช้ fallback ตามชนิดวัตถุดิบ
          if (lowerTitle.includes('นมจืด') || lowerTitle.includes('นมสด') || lowerTitle.includes('เมจิ')) {
            const ozPerBatch = 1.5 * batchScale;
            amountInput.value = ozPerBatch.toFixed(1);
            setFixedUnit('oz');

            if (parsedUnit === 'ml' || parsedUnit === 'มล') {
              autoUse = Math.round(ozPerBatch * 29.57 * 10) / 10;
            } else if (parsedUnit === 'ลิตร' || parsedUnit === 'l' || parsedUnit === 'liter') {
              autoUse = Math.round(((ozPerBatch * 29.57) / 1000) * 100) / 100;
            } else if (parsedUnit.includes('กป') || parsedUnit.includes('กระป๋อง')) {
              autoUse = Math.round((ozPerBatch / 13) * 10) / 10;
            } else if (parsedUnit === 'g' || parsedUnit === 'กรัม') {
              autoUse = Math.round(ozPerBatch * 31);
            } else if (parsedUnit === 'kg' || parsedUnit === 'กก') {
              autoUse = Math.round(((ozPerBatch * 31) / 1000) * 100) / 100;
            } else {
              autoUse = Math.round(ozPerBatch * 10) / 10;
            }
          } else if (lowerTitle.includes('นมข้นหวาน') || lowerTitle.includes('นมหวาน')) {
            const ozPerBatch = 1.0 * batchScale;
            amountInput.value = ozPerBatch.toFixed(1);
            setFixedUnit('oz');

            if (parsedUnit.includes('กป') || parsedUnit.includes('กระป๋อง')) {
              autoUse = Math.round((ozPerBatch / 13) * 10) / 10;
            } else if (parsedUnit === 'g' || parsedUnit === 'กรัม') {
              autoUse = Math.round(ozPerBatch * 38.8);
            } else if (parsedUnit === 'kg' || parsedUnit === 'กก') {
              autoUse = Math.round(((ozPerBatch * 38.8) / 1000) * 100) / 100;
            } else {
              autoUse = Math.round(ozPerBatch * 10) / 10;
            }
          } else if (lowerTitle.includes('นมข้นจืด') || lowerTitle.includes('คาร์เนชัน')) {
            const ozPerBatch = 1.5 * batchScale;
            amountInput.value = ozPerBatch.toFixed(1);
            setFixedUnit('oz');

            if (parsedUnit.includes('กป') || parsedUnit.includes('กระป๋อง')) {
              autoUse = Math.round((ozPerBatch / 13) * 10) / 10;
            } else if (parsedUnit === 'g' || parsedUnit === 'กรัม') {
              autoUse = Math.round(ozPerBatch * 32);
            } else if (parsedUnit === 'kg' || parsedUnit === 'กก') {
              autoUse = Math.round(((ozPerBatch * 32) / 1000) * 100) / 100;
            } else {
              autoUse = Math.round(ozPerBatch * 10) / 10;
            }
          } else if (lowerTitle.includes('ชา') || lowerTitle.includes('โกโก้') || lowerTitle.includes('กาแฟ')) {
            const gPerBatch = Math.round((matchedCupAmount > 0 ? matchedCupAmount : 18) * batchScale);
            amountInput.value = gPerBatch;
            setFixedUnit('g');

            if (parsedUnit === 'g' || parsedUnit === 'กรัม') {
              autoUse = gPerBatch;
            } else if (parsedUnit === 'kg' || parsedUnit === 'กก') {
              autoUse = Math.round((gPerBatch / 1000) * 100) / 100;
            } else if (parsedUnit.includes('ถุง') || parsedUnit.includes('ห่อ')) {
              autoUse = Math.round((gPerBatch / (parsedSize > 10 ? parsedSize : 400)) * 10) / 10;
            } else {
              autoUse = gPerBatch;
            }
          } else {
            autoUse = 1;
            amountInput.value = 1;
            setFixedUnit(parsedUnit || 'หน่วย');
          }
        }

        useAmountInput.value = autoUse || 1;
        runPackCalc();
      });
    }

    // ฟังก์ชันคำนวณ useAmount จากค่าใน amountInput อัตโนมัติเมื่อผู้ใช้แก้ไขช่องปริมาณใช้ (ผู้ใช้กรอกเฉพาะตัวเลข)
    const syncAmountInputToUseAmount = () => {
      const rawVal = amountInput.value.trim();
      if (!rawVal) return;

      const numVal = parseFloat(rawVal.replace(/,/g, ''));
      if (isNaN(numVal) || numVal <= 0) return;

      const packUnit = (packUnitInput.value || '').trim();
      const packSize = parseFloat(packSizeInput.value) || 1;
      const lowerRowName = (nameInput.value || '').toLowerCase();
      const inputUnit = (amountUnitInput?.value || amountUnit || '').toLowerCase();

      let calculatedUse = numVal;

      if (inputUnit === 'oz') {
        if (packUnit === 'ml' || packUnit === 'มล') {
          calculatedUse = Math.round(numVal * 29.57 * 10) / 10;
        } else if (packUnit === 'ลิตร' || packUnit === 'l' || packUnit === 'liter') {
          calculatedUse = Math.round(((numVal * 29.57) / 1000) * 100) / 100;
        } else if (packUnit.includes('กป') || packUnit.includes('กระป๋อง')) {
          calculatedUse = Math.round((numVal / 13) * 10) / 10;
        } else if (packUnit === 'g' || packUnit === 'กรัม') {
          const gPerOz = lowerRowName.includes('หวาน') ? 38.8 : 31;
          calculatedUse = Math.round(numVal * gPerOz);
        } else if (packUnit === 'kg' || packUnit === 'กก') {
          const gPerOz = lowerRowName.includes('หวาน') ? 38.8 : 31;
          calculatedUse = Math.round(((numVal * gPerOz) / 1000) * 100) / 100;
        } else {
          calculatedUse = Math.round(numVal * 10) / 10;
        }
      } else if (inputUnit === 'g' || inputUnit === 'กรัม') {
        if (packUnit === 'g' || packUnit === 'กรัม') {
          calculatedUse = Math.round(numVal);
        } else if (packUnit === 'kg' || packUnit === 'กก') {
          calculatedUse = Math.round((numVal / 1000) * 100) / 100;
        } else if (packUnit.includes('ถุง') || packUnit.includes('ห่อ')) {
          calculatedUse = Math.round((numVal / (packSize > 10 ? packSize : 400)) * 10) / 10;
        } else {
          calculatedUse = Math.round(numVal);
        }
      } else if (inputUnit === 'ml' || inputUnit === 'มล') {
        if (packUnit === 'ml' || packUnit === 'มล') {
          calculatedUse = Math.round(numVal);
        } else if (packUnit === 'ลิตร' || packUnit === 'l' || packUnit === 'liter') {
          calculatedUse = Math.round((numVal / 1000) * 100) / 100;
        } else {
          calculatedUse = Math.round(numVal);
        }
      } else if (packUnit.includes('ถุง') || packUnit.includes('ห่อ')) {
        // กรณีตัวเลขเป็นกรัมแต่ไม่ได้ใส่หน่วย g
        if (numVal > 10 && packSize > 0) {
          calculatedUse = Math.round((numVal / packSize) * 10) / 10;
        }
      }

      if (calculatedUse > 0) {
        useAmountInput.value = calculatedUse;

        // คำนวณต้นทุนต่อโหลทันที
        const price = parseFloat(packPriceInput.value) || 0;
        if (price > 0 && packSize > 0) {
          const calculatedCost = Math.round(((price / packSize) * calculatedUse) * 100) / 100;
          costInput.value = calculatedCost;
          badgeText.textContent = `💡 ซื้อมา ฿${price} (${packSize} ${packUnit || 'หน่วย'}) | ใช้ ${calculatedUse} ${packUnit || 'หน่วย'} = ต้นทุน ฿${calculatedCost.toFixed(2)}`;
          badgeText.style.color = 'var(--primary)';
          toggleBtn.classList.add('active');
        }
        this.updateRecipeModalCalculations();
      }
    };

    amountInput.addEventListener('input', syncAmountInputToUseAmount);
    useAmountInput.addEventListener('input', runPackCalc);

    row.querySelector('.btn-icon-danger').addEventListener('click', () => {
      row.remove();
      this.updateRecipeModalCalculations();
    });

    costInput.addEventListener('input', () => {
      this.updateRecipeModalCalculations();
    });

    container.appendChild(row);
    this.updateRecipeModalCalculations();
  }

  calculateRecommendedPrices(unitCost) {
    if (unitCost <= 0) {
      return [
        { label: 'ขายเร็ว / นักเรียน', margin: '40%', price: 20, profit: 20 },
        { label: 'มาตรฐานยอดนิยม', margin: '50%', price: 25, profit: 25 },
        { label: 'พรีเมียม / หวานมัน', margin: '60%', price: 30, profit: 30 }
      ];
    }

    // แนะนำ 3 ระดับราคาตามสัดส่วนกำไร (Margin) ในธุรกิจเครื่องดื่ม
    // 1. ระดับเน้นขายง่าย/ปริมาณ (กำไร ~40%): ต้นทุน / 0.60
    // 2. ระดับมาตรฐานแนะนำ (กำไร ~50%): ต้นทุน / 0.50
    // 3. ระดับพรีเมียม/คาเฟ่ (กำไร ~60%): ต้นทุน / 0.40
    const calcRoundPrice = (raw) => {
      if (raw <= 15) return Math.ceil(raw);
      // ปัดเป็นจำนวนเต็ม 5 หรือ 10 เช่น 20, 25, 30, 35
      return Math.ceil(raw / 5) * 5;
    };

    const p1 = Math.max(calcRoundPrice(unitCost / 0.65), Math.ceil(unitCost + 5));
    let p2 = Math.max(calcRoundPrice(unitCost / 0.50), p1 + 5);
    let p3 = Math.max(calcRoundPrice(unitCost / 0.40), p2 + 5);

    return [
      {
        label: 'ขายง่าย / เน้นยอด',
        desc: 'กำไรเริ่มต้น',
        margin: `${Math.round(((p1 - unitCost) / p1) * 100)}%`,
        price: p1,
        profit: p1 - unitCost
      },
      {
        label: '⭐ แนะนำขายดี',
        desc: 'กำไรมาตรฐาน 50%',
        margin: `${Math.round(((p2 - unitCost) / p2) * 100)}%`,
        price: p2,
        profit: p2 - unitCost,
        highlight: true
      },
      {
        label: 'พรีเมียม / เข้มข้น',
        desc: 'กำไรสูง',
        margin: `${Math.round(((p3 - unitCost) / p3) * 100)}%`,
        price: p3,
        profit: p3 - unitCost
      }
    ];
  }

  updateRecipeModalCalculations() {
    const isCup = document.getElementById('recMode')?.value === 'cup';
    const costInputs = document.querySelectorAll('#recipeIngredientsContainer .ing-cost');
    let totalJarCost = 0;
    costInputs.forEach(input => {
      totalJarCost += parseFloat(input.value) || 0;
    });

    const yieldCups = isCup ? 1 : (parseInt(document.getElementById('recYieldCups')?.value) || 12);
    const unitCost = isCup ? totalJarCost : (yieldCups > 0 ? (totalJarCost / yieldCups) : 0);

    const totalJarCostElem = document.getElementById('modalRecipeTotalJarCost');
    const unitCostElem = document.getElementById('modalRecipeUnitCost');
    if (totalJarCostElem) totalJarCostElem.textContent = this.formatCurrency(totalJarCost);
    if (unitCostElem) unitCostElem.textContent = `฿${unitCost.toFixed(2)}`;

    // Live calculation based on user-entered selling price
    const priceInput = document.getElementById('recSellingPrice');
    const sellingPrice = priceInput ? (parseFloat(priceInput.value) || 0) : 25;
    const profitPerCup = sellingPrice - unitCost;
    const marginPercent = sellingPrice > 0 ? Math.round(((profitPerCup / sellingPrice) * 100)) : 0;
    const totalJarProfit = profitPerCup * yieldCups;

    const profitPerCupElem = document.getElementById('modalRecipeProfitPerCup');
    const marginPercentElem = document.getElementById('modalRecipeMarginPercent');
    const totalJarProfitElem = document.getElementById('modalRecipeTotalJarProfit');

    if (profitPerCupElem) {
      profitPerCupElem.textContent = `${profitPerCup >= 0 ? '+' : ''}฿${profitPerCup.toFixed(2)}`;
      profitPerCupElem.className = `font-bold ${profitPerCup >= 0 ? 'text-success' : 'text-danger'}`;
    }
    if (marginPercentElem) {
      marginPercentElem.textContent = `${marginPercent}%`;
      marginPercentElem.className = `font-bold ${marginPercent >= 0 ? 'text-primary' : 'text-danger'}`;
    }
    if (totalJarProfitElem) {
      totalJarProfitElem.textContent = this.formatCurrency(totalJarProfit);
      totalJarProfitElem.className = `font-bold ${totalJarProfit >= 0 ? 'text-amber' : 'text-danger'}`;
    }

    // 💡 ระบบแนะนำลดต้นทุนวัตถุดิบและปรับส่วนผสมเมื่อกำไรน้อย (สำหรับทั้งสูตรโหลและสูตรแก้ว)
    this.renderRecipeCostOptimizationAdvice({
      isCup,
      unitCost,
      sellingPrice,
      profitPerCup,
      marginPercent,
      totalJarProfit,
      yieldCups,
      totalJarCost
    });
  }

  // คำนวณสูตรปรับลดสัดส่วนเพื่อให้ได้กำไรต่อแก้วไม่น้อยกว่า 5 บาท
  calculate5BahtOptimizedRecipe(targetProfit = 5.0) {
    const isCup = document.getElementById('recMode')?.value === 'cup';
    const yieldCups = isCup ? 1 : (parseInt(document.getElementById('recYieldCups')?.value) || 12);
    const priceInput = document.getElementById('recSellingPrice');
    const sellingPrice = priceInput ? (parseFloat(priceInput.value) || 0) : 25;

    // เพดานต้นทุนต่อแก้วเพื่อให้ได้กำไร targetProfit (เช่น 5 บาท)
    const targetUnitCost = Math.max(0, sellingPrice - targetProfit);
    const targetTotalCost = targetUnitCost * yieldCups;

    const ingredientRows = document.querySelectorAll('#recipeIngredientsContainer .ingredient-row');
    if (ingredientRows.length === 0) return null;

    const items = [];
    let currentTotalCost = 0;
    let packagingCost = 0;
    let beverageCost = 0;

    ingredientRows.forEach((row, index) => {
      const name = (row.querySelector('.ing-name')?.value || '').trim();
      const cost = parseFloat(row.querySelector('.ing-cost')?.value) || 0;
      const amountVal = parseFloat(row.querySelector('.ing-amount')?.value) || 0;
      const unit = (row.querySelector('.ing-amount-unit')?.value || 'oz').trim();
      const useAmount = parseFloat(row.querySelector('.calc-use-amount')?.value) || 0;
      const packUnit = (row.querySelector('.calc-unit-label')?.textContent || '').trim();
      const packPrice = parseFloat(row.querySelector('.calc-pack-price')?.value) || 0;
      const packSize = parseFloat(row.querySelector('.calc-pack-size')?.value) || 0;

      const lowerName = name.toLowerCase();
      const isPkg = lowerName.includes('แก้ว') || lowerName.includes('ฝา') || lowerName.includes('หลอด') ||
        lowerName.includes('ถุง') || unit === 'ชุด' || unit === 'ใบ' || unit === 'ชิ้น';
      const isZeroCost = cost <= 0;

      currentTotalCost += cost;
      if (isPkg || isZeroCost) {
        packagingCost += cost;
      } else {
        beverageCost += cost;
      }

      items.push({
        rowIndex: index,
        rowElem: row,
        name,
        origCost: cost,
        origAmountVal: amountVal,
        unit,
        origUseAmount: useAmount,
        packUnit,
        packPrice,
        packSize,
        isPkg,
        isZeroCost
      });
    });

    const currentUnitCost = yieldCups > 0 ? (currentTotalCost / yieldCups) : 0;
    const currentProfitPerCup = sellingPrice - currentUnitCost;

    // คำนวณอัตราส่วนการปรับลด (Reduction Ratio)
    let ratio = 1;
    if (targetTotalCost <= packagingCost) {
      // หากราคาขายต่ำมากจนหักบรรจุภัณฑ์และของฟรีแล้วแทบไม่เหลือ ให้ลดส่วนผสมที่มีต้นทุนลง 50%
      ratio = 0.5;
    } else if (beverageCost > 0) {
      const targetBeverageCost = targetTotalCost - packagingCost;
      ratio = Math.max(0.2, Math.min(1.0, targetBeverageCost / beverageCost));
    } else if (currentTotalCost > 0) {
      ratio = Math.max(0.2, Math.min(1.0, targetTotalCost / currentTotalCost));
    }

    let optimizedTotalCost = 0;
    const optimizedItems = items.map(item => {
      let newAmountVal = item.origAmountVal;
      let newUseAmount = item.origUseAmount;
      let newCost = item.origCost;

      // ถ้าเป็นบรรจุภัณฑ์ หรือ รายการราคา 0 บาท (เช่น น้ำร้อน, น้ำเปล่า, วัตถุดิบฟรี) ไม่ต้องปรับสูตร
      if (!item.isPkg && !item.isZeroCost) {
        // ปรับลดเฉพาะส่วนผสมเครื่องดื่มที่มีต้นทุน (> 0 บาท)
        newAmountVal = Math.round((item.origAmountVal * ratio) * 10) / 10;
        if (item.origAmountVal > 0 && newAmountVal <= 0) newAmountVal = 0.1;

        if (item.origUseAmount > 0) {
          newUseAmount = Math.round((item.origUseAmount * ratio) * 100) / 100;
          if (newUseAmount <= 0) newUseAmount = 0.01;
        }

        // คำนวณต้นทุนใหม่
        if (item.packPrice > 0 && item.packSize > 0 && newUseAmount > 0) {
          newCost = Math.round(((item.packPrice / item.packSize) * newUseAmount) * 100) / 100;
        } else {
          newCost = Math.round((item.origCost * ratio) * 100) / 100;
        }
      }

      optimizedTotalCost += newCost;

      const diffAmount = Math.round((item.origAmountVal - newAmountVal) * 10) / 10;
      const diffCost = Math.round((item.origCost - newCost) * 100) / 100;
      const diffPercent = item.origCost > 0 ? Math.round(((item.origCost - newCost) / item.origCost) * 100) : 0;

      return {
        ...item,
        newAmountVal,
        newUseAmount,
        newCost,
        diffAmount,
        diffCost,
        diffPercent
      };
    });

    const optimizedUnitCost = yieldCups > 0 ? (optimizedTotalCost / yieldCups) : 0;
    const optimizedProfitPerCup = sellingPrice - optimizedUnitCost;

    return {
      sellingPrice,
      yieldCups,
      isCup,
      currentUnitCost,
      currentProfitPerCup,
      currentTotalCost,
      optimizedUnitCost,
      optimizedProfitPerCup,
      optimizedTotalCost,
      ratio,
      reductionPercent: Math.round((1 - ratio) * 100),
      items: optimizedItems
    };
  }

  // ฟังก์ชันแทนที่ค่าในตารางสูตรโหลด้วยสูตรปรับกำไร 5 บาททันที
  apply5BahtOptimizedRecipe() {
    const opt = this.calculate5BahtOptimizedRecipe(5.0);
    if (!opt || !opt.items) return;

    opt.items.forEach(item => {
      const row = item.rowElem;
      if (!row) return;

      const amountInput = row.querySelector('.ing-amount');
      const useAmountInput = row.querySelector('.calc-use-amount');
      const costInput = row.querySelector('.ing-cost');
      const badgeText = row.querySelector('.calc-badge-text');

      if (amountInput) amountInput.value = item.newAmountVal;
      if (useAmountInput && item.newUseAmount > 0) useAmountInput.value = item.newUseAmount;
      if (costInput) costInput.value = item.newCost.toFixed(2);

      if (badgeText && item.packPrice > 0 && item.packSize > 0) {
        badgeText.textContent = `💡 ซื้อมา ฿${item.packPrice} (${item.packSize} ${item.packUnit || 'หน่วย'}) | ใช้ ${item.newUseAmount} ${item.packUnit || 'หน่วย'} = ต้นทุน ฿${item.newCost.toFixed(2)} (สูตรปรับกำไร ฿5)`;
        badgeText.style.color = 'var(--primary)';
      }
    });

    this.updateRecipeModalCalculations();
    this.showToast(`ปรับลดอัตราส่วนเป็นสูตรกำไร ฿${opt.optimizedProfitPerCup.toFixed(2)}/แก้ว เรียบร้อยแล้ว!`, 'success');
  }

  renderRecipeCostOptimizationAdvice({ isCup, unitCost, sellingPrice, profitPerCup, marginPercent, totalJarProfit, yieldCups, totalJarCost }) {
    const adviceContainer = document.getElementById('recipeAdviceContainer');
    if (!adviceContainer) return;

    // ถ้ายังไม่ได้กรอกราคาขาย หรือยังไม่มีต้นทุน ไม่ต้องแสดง
    if (sellingPrice <= 0 || unitCost <= 0) {
      adviceContainer.style.display = 'none';
      adviceContainer.innerHTML = '';
      return;
    }

    // กรณีพิเศษสำคัญ: หากได้กำไรต่อแก้วน้อยกว่า 5 บาท (< 5 บาท)
    if (profitPerCup < 5.0) {
      const opt = this.calculate5BahtOptimizedRecipe(5.0);
      const profitDiff = (opt.optimizedProfitPerCup - profitPerCup);
      const totalJarProfitDiff = (opt.optimizedProfitPerCup * yieldCups) - totalJarProfit;
      const unitCostDiff = (unitCost - opt.optimizedUnitCost);

      adviceContainer.style.display = 'block';
      adviceContainer.innerHTML = `
        <div class="recipe-5baht-card" style="background:#fff7ed; border:2px solid #fb923c; border-radius:var(--radius-md); padding:1rem; box-shadow:0 4px 14px rgba(249,115,22,0.12); margin-top:0.75rem;">
          <!-- Header Badge -->
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.75rem; flex-wrap:wrap; gap:0.5rem;">
            <div>
              <div style="display:flex; align-items:center; gap:0.4rem; font-weight:800; color:#c2410c; font-size:0.95rem;">
                <span style="font-size:1.2rem;">⚠️</span>
                <span>กำไรต่อแก้วน้อยกว่า 5 บาท! (ปัจจุบันได้กำไร ฿${profitPerCup.toFixed(2)} / แก้ว)</span>
              </div>
              <div style="font-size:0.8rem; color:#9a3412; margin-top:2px;">
                ระบบคำนวณปรับลดอัตราส่วนวัตถุดิบลง <strong>${opt.reductionPercent}%</strong> เพื่อให้ได้กำไรไม่น้อยกว่า <strong>฿5.00/แก้ว</strong> ตามมาตรฐาน
              </div>
            </div>
            <span class="pill-tag" style="background:#ffedd5; color:#c2410c; font-size:0.75rem; font-weight:800; border:1px solid #fdba74;">
              🎯 เป้าหมายกำไร ฿5.00+
            </span>
          </div>

          <!-- Overall Comparison Cards -->
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:0.5rem; margin-bottom:0.85rem;">
            <div style="background:#ffffff; border:1px solid #fed7aa; border-radius:var(--radius-sm); padding:0.6rem; text-align:center;">
              <div style="font-size:0.72rem; color:#78350f; font-weight:600;">สูตรที่ควรปรุง (เดิม)</div>
              <div style="font-size:1rem; font-weight:800; color:#dc2626;">฿${profitPerCup.toFixed(2)}/แก้ว</div>
              <div style="font-size:0.7rem; color:#9ca3af;">ต้นทุน ฿${unitCost.toFixed(2)}</div>
            </div>
            <div style="background:#ecfdf5; border:1.5px solid #10b981; border-radius:var(--radius-sm); padding:0.6rem; text-align:center;">
              <div style="font-size:0.72rem; color:#065f46; font-weight:700;">ปรับให้ได้กำไร 5 บาท (ใหม่)</div>
              <div style="font-size:1rem; font-weight:800; color:#059669;">+฿${opt.optimizedProfitPerCup.toFixed(2)}/แก้ว</div>
              <div style="font-size:0.7rem; color:#047857;">ต้นทุน ฿${opt.optimizedUnitCost.toFixed(2)}</div>
            </div>
            <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:var(--radius-sm); padding:0.6rem; text-align:center;">
              <div style="font-size:0.72rem; color:#1e40af; font-weight:600;">กำไรเพิ่มขึ้นต่อแก้ว</div>
              <div style="font-size:1rem; font-weight:800; color:#2563eb;">+฿${profitDiff.toFixed(2)}/แก้ว</div>
              <div style="font-size:0.7rem; color:#1d4ed8;">${!isCup ? `(+฿${Math.round(totalJarProfitDiff).toLocaleString()} ต่อโหล)` : 'ประหยัดต้นทุน'}</div>
            </div>
          </div>

          <!-- Detailed Ingredient Comparison Table -->
          <div style="font-size:0.8rem; font-weight:700; color:#7c2d12; margin-bottom:0.4rem; display:flex; align-items:center; gap:0.35rem;">
            <span>📊</span>
            <span>เปรียบเทียบสัดส่วน: สูตรที่ควรปรุง vs ปรับให้ได้กำไร 5 บาท (แตกต่างกันเท่าไหร่):</span>
          </div>

          <div style="background:#ffffff; border:1px solid #fed7aa; border-radius:var(--radius-sm); overflow-x:auto; margin-bottom:0.85rem;">
            <table style="width:100%; border-collapse:collapse; font-size:0.775rem; text-align:left;">
              <thead>
                <tr style="background:#ffedd5; color:#9a3412; border-bottom:1px solid #fed7aa;">
                  <th style="padding:0.45rem 0.6rem; font-weight:700;">วัตถุดิบ</th>
                  <th style="padding:0.45rem 0.6rem; font-weight:700; text-align:center;">สูตรที่ควรปรุง (เดิม)</th>
                  <th style="padding:0.45rem 0.6rem; font-weight:700; text-align:center; color:#065f46;">ปรับให้ได้กำไร 5 บ. (ใหม่)</th>
                  <th style="padding:0.45rem 0.6rem; font-weight:700; text-align:right;">ส่วนต่างที่ลดลง</th>
                </tr>
              </thead>
              <tbody>
                ${opt.items.map((item, idx) => {
        const isBgEven = idx % 2 === 0 ? '#ffffff' : '#fffbeb';
        if (item.isZeroCost) {
          return `
                      <tr style="background:${isBgEven}; border-bottom:1px solid #fef3c7;">
                        <td style="padding:0.45rem 0.6rem; font-weight:600; color:#374151;">
                          ${this.escapeHtml(item.name)} <span style="font-size:0.68rem; color:#10b981; font-weight:700;">(฿0 ฟรี)</span>
                        </td>
                        <td style="padding:0.45rem 0.6rem; text-align:center; color:#4b5563;">${item.origAmountVal} ${item.unit} (฿0.00)</td>
                        <td style="padding:0.45rem 0.6rem; text-align:center; color:#4b5563;">${item.newAmountVal} ${item.unit} (฿0.00)</td>
                        <td style="padding:0.45rem 0.6rem; text-align:right; color:#10b981; font-size:0.72rem; font-weight:600;">0 บาท (คงเดิม ไม่ปรับ)</td>
                      </tr>
                    `;
        }
        if (item.isPkg) {
          return `
                      <tr style="background:${isBgEven}; border-bottom:1px solid #fef3c7;">
                        <td style="padding:0.45rem 0.6rem; font-weight:600; color:#374151;">
                          ${this.escapeHtml(item.name)} <span style="font-size:0.68rem; color:#9ca3af;">(บรรจุภัณฑ์)</span>
                        </td>
                        <td style="padding:0.45rem 0.6rem; text-align:center; color:#4b5563;">${item.origAmountVal} ${item.unit} (฿${item.origCost.toFixed(2)})</td>
                        <td style="padding:0.45rem 0.6rem; text-align:center; color:#4b5563;">${item.newAmountVal} ${item.unit} (฿${item.newCost.toFixed(2)})</td>
                        <td style="padding:0.45rem 0.6rem; text-align:right; color:#9ca3af; font-size:0.72rem;">คงที่ (ไม่ปรับ)</td>
                      </tr>
                    `;
        }
        return `
                    <tr style="background:${isBgEven}; border-bottom:1px solid #fef3c7;">
                      <td style="padding:0.45rem 0.6rem; font-weight:700; color:#1f2937;">
                        ${this.escapeHtml(item.name)}
                      </td>
                      <td style="padding:0.45rem 0.6rem; text-align:center; color:#4b5563;">
                        ${item.origAmountVal} ${item.unit} <span style="font-size:0.7rem; color:#9ca3af;">(฿${item.origCost.toFixed(2)})</span>
                      </td>
                      <td style="padding:0.45rem 0.6rem; text-align:center; font-weight:700; color:#059669;">
                        ${item.newAmountVal} ${item.unit} <span style="font-size:0.7rem; color:#047857;">(฿${item.newCost.toFixed(2)})</span>
                      </td>
                      <td style="padding:0.45rem 0.6rem; text-align:right; font-weight:700; color:#dc2626;">
                        -${item.diffAmount} ${item.unit} (-฿${item.diffCost.toFixed(2)} | -${item.diffPercent}%)
                      </td>
                    </tr>
                  `;
      }).join('')}
              </tbody>
              <tfoot>
                <tr style="background:#fef3c7; font-weight:800; border-top:1.5px solid #fed7aa; color:#78350f;">
                  <td style="padding:0.5rem 0.6rem;">รวมต้นทุนทั้งหมด:</td>
                  <td style="padding:0.5rem 0.6rem; text-align:center; color:#dc2626;">฿${unitCost.toFixed(2)}/แก้ว</td>
                  <td style="padding:0.5rem 0.6rem; text-align:center; color:#059669;">฿${opt.optimizedUnitCost.toFixed(2)}/แก้ว</td>
                  <td style="padding:0.5rem 0.6rem; text-align:right; color:#059669;">ลดลง ฿${unitCostDiff.toFixed(2)}/แก้ว</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <!-- Action Buttons -->
          <div style="display:flex; justify-content:flex-end; gap:0.5rem; flex-wrap:wrap; align-items:center;">
            <span style="font-size:0.75rem; color:#9a3412; margin-right:auto;">
              💡 คลิกปุ่มเพื่ออัปเดตสัดส่วนลงในตารางส่วนผสมทันที
            </span>
            <button type="button" id="btnApplyOptimized5Baht" class="btn-fastwork-sm"
              style="background:#059669; border-color:#047857; color:#ffffff; font-weight:700; padding:0.45rem 0.9rem; box-shadow:0 2px 6px rgba(5,150,105,0.25);">
              <span>⚡ ปรับใช้สูตรกำไร 5 บาททันที</span>
            </button>
          </div>
        </div>
      `;

      const btnApply = document.getElementById('btnApplyOptimized5Baht');
      if (btnApply) {
        btnApply.onclick = () => {
          this.apply5BahtOptimizedRecipe();
        };
      }
      return;
    }

    // กำไรต่ำทั่วไปเมื่อ margin < 45% หรือ profitPerCup < 10 บาท
    const isLowProfit = marginPercent < 45 || profitPerCup < 10;

    if (!isLowProfit) {
      adviceContainer.style.display = 'block';
      adviceContainer.innerHTML = `
        <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: var(--radius-sm); padding: 0.75rem 1rem; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;">
          <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; color: #065f46; font-weight: 600;">
            <span style="font-size: 1.15rem;">🎉</span>
            <span>สูตรนี้มีมาร์จิ้นกำไรดีเยี่ยม <strong>(${marginPercent}%)</strong> ได้กำไร ฿${profitPerCup.toFixed(2)}/แก้ว ${!isCup ? `(ขายหมดโหลได้กำไรสุทธิ ฿${Math.round(totalJarProfit).toLocaleString()})` : ''} พร้อมขายได้ทันที!</span>
          </div>
        </div>
      `;
      return;
    }

    // วิเคราะห์รายการวัตถุดิบที่ใช้ต้นทุนสูงที่สุด (Top Cost Contributors)
    const ingredientRows = document.querySelectorAll('#recipeIngredientsContainer .ingredient-row');
    const items = [];
    ingredientRows.forEach(row => {
      const name = (row.querySelector('.ing-name')?.value || '').trim();
      const cost = parseFloat(row.querySelector('.ing-cost')?.value) || 0;
      const amountVal = row.querySelector('.ing-amount')?.value || '';
      const unit = row.querySelector('.ing-amount-unit')?.value || '';
      const useAmount = parseFloat(row.querySelector('.calc-use-amount')?.value) || 0;
      const packUnit = row.querySelector('.calc-unit-label')?.textContent || '';
      if (name && cost > 0) {
        items.push({ name, cost, amountVal, unit, useAmount, packUnit });
      }
    });

    items.sort((a, b) => b.cost - a.cost);
    const topExpensive = items.slice(0, 3);
    const totalCostSum = items.reduce((sum, item) => sum + item.cost, 0);

    // สร้างคำแนะนำเฉพาะเจาะจงตามประเภทวัตถุดิบและสัดส่วนต้นทุน
    const tips = [];

    // 1. แนะนำวัตถุดิบที่กินต้นทุนสูงสุด
    if (topExpensive.length > 0) {
      const mainItem = topExpensive[0];
      const pctOfCost = totalCostSum > 0 ? Math.round((mainItem.cost / totalCostSum) * 100) : 0;
      const lowerName = mainItem.name.toLowerCase();

      if (lowerName.includes('นม') || lowerName.includes('ข้น') || lowerName.includes('สด') || lowerName.includes('จืด') || lowerName.includes('ครีม')) {
        tips.push(`<strong>ลดสัดส่วนนม/ครีม:</strong> "<strong>${this.escapeHtml(mainItem.name)}</strong>" กินต้นทุนไปถึง <strong>${pctOfCost}%</strong> (฿${mainItem.cost.toFixed(2)}) ลองลดปริมาณลง 0.25–0.5 oz ต่อแก้ว หรือเปลี่ยนมาใช้ครีมเทียมข้นหวานแบบถุงเติม 2 กก. แทนกระป๋องเล็ก`);
      } else if (lowerName.includes('ชา') || lowerName.includes('กาแฟ') || lowerName.includes('โกโก้')) {
        tips.push(`<strong>ปรับการสกัดชา:</strong> "<strong>${this.escapeHtml(mainItem.name)}</strong>" เป็นสัดส่วนต้นทุน <strong>${pctOfCost}%</strong> (฿${mainItem.cost.toFixed(2)}) ลองผสมใบชาสูตรผสมเบลนด์ (เช่น ชาตรามือผสมชาเข้มข้นทางใต้) ช่วยลดปริมาณผงชาแต่ได้รสและสีที่เข้มข้นเท่าเดิม`);
      } else if (lowerName.includes('แก้ว') || lowerName.includes('ฝา') || lowerName.includes('หลอด') || lowerName.includes('ถุง')) {
        tips.push(`<strong>เปลี่ยนบรรจุภัณฑ์:</strong> "<strong>${this.escapeHtml(mainItem.name)}</strong>" ต้นทุน ฿${mainItem.cost.toFixed(2)} ลองซื้อยกลัง (1,000–2,000 ใบ) หรือเปลี่ยนจากแก้วแข็ง PP/PET หนา มาเป็นแก้วพิมพ์ลายมาตรฐาน ต้นทุนจะลดลง ฿0.80–฿1.20/แก้ว`);
      } else {
        tips.push(`<strong>เจรจาหรือซื้อแพ็กใหญ่ขึ้น:</strong> "<strong>${this.escapeHtml(mainItem.name)}</strong>" ต้นทุน ฿${mainItem.cost.toFixed(2)} (<strong>${pctOfCost}%</strong> ของสูตร) ลองซื้อขนาดขายส่ง/ยกลังจาก Makro เพื่อลดต้นทุนต่อหน่วย`);
      }
    }

    // 2. แนะนำการปรับราคาขายที่เหมาะสมกับต้นทุนจริง
    const targetPrice50 = Math.ceil((unitCost / 0.5) / 5) * 5; // ราคาที่ได้กำไร 50% ปัดเป็นเลข 5
    if (targetPrice50 > sellingPrice) {
      tips.push(`<strong>ปรับราคาขายขึ้นเล็กน้อย:</strong> หากรสชาตินี้เข้มข้นเป็นเอกลักษณ์อยู่แล้ว แนะนำตั้งราคาที่ <strong>฿${targetPrice50}</strong> (ได้กำไร 50% ขึ้นไป) หรือเพิ่มเป็นเมนู "พรีเมียม/ชงเข้ม"`);
    }

    // 3. แนะนำด้านปริมาตรแก้วและน้ำแข็ง
    if (!isCup) {
      tips.push(`<strong>เสิร์ฟน้ำแข็งเต็มแก้ว:</strong> สัดส่วนน้ำชงมาตรฐานถัง ${document.getElementById('recJarLiters')?.value || 6} ลิตร หากตักน้ำแข็งบด/เกล็ดเต็มแก้ว จะเสิร์ฟได้เฉลี่ยเพิ่มขึ้นอีก 2–4 แก้วต่อถัง ช่วยเพิ่มกำไรสุทธิรวม`);
    }

    adviceContainer.style.display = 'block';
    adviceContainer.innerHTML = `
      <div style="background: #fffbeb; border: 1.5px solid #fde68a; border-radius: var(--radius-sm); padding: 0.85rem 1rem; margin-top: 0.5rem; box-shadow: 0 1px 3px rgba(245, 158, 11, 0.08);">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
          <div style="display: flex; align-items: center; gap: 0.4rem; font-weight: 700; color: #b45309; font-size: 0.875rem;">
            <span>⚠️</span>
            <span>สูตรนี้กำไรค่อนข้างน้อย (${marginPercent}% / กำไร ฿${profitPerCup.toFixed(2)} ต่อแก้ว)</span>
          </div>
          <span class="pill-tag" style="background:#fef3c7; color:#92400e; font-size:0.7rem; font-weight:700;">💡 คำแนะนำเพิ่มกำไร</span>
        </div>

        <div style="font-size: 0.825rem; color: #78350f; line-height: 1.55; margin-bottom: 0.5rem;">
          ${topExpensive.length > 0 ? `<strong>วัตถุดิบต้นทุนสูงสุด 3 อันดับแรก:</strong> ${topExpensive.map((t, idx) => `${idx + 1}. ${this.escapeHtml(t.name)} (฿${t.cost.toFixed(2)})`).join(' | ')}` : ''}
        </div>

        <ul style="margin: 0; padding-left: 1.25rem; font-size: 0.825rem; color: #92400e; line-height: 1.6;">
          ${tips.map(tip => `<li style="margin-bottom: 0.35rem;">${tip}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  handleExpenseSubmit() {
    try {
      const editId = document.getElementById('expenseEditId')?.value || '';
      let date = document.getElementById('expDateInput')?.value || '';
      if (!date) {
        date = this.formatDate(new Date());
        const dEl = document.getElementById('expDateInput');
        if (dEl) dEl.value = date;
      }

      const title = document.getElementById('expTitle')?.value.trim() || '';
      if (!title) {
        this.showToast('กรุณาระบุชื่อรายการสินค้า / วัตถุดิบ', 'error');
        document.getElementById('expTitle')?.focus();
        return;
      }

      const category = document.getElementById('expCategory')?.value || 'INGREDIENT';
      const amountVal = parseFloat(document.getElementById('expAmount')?.value);
      const amount = (!isNaN(amountVal) && amountVal >= 0) ? amountVal : 0;

      const expQtyDescInput = document.getElementById('expQuantityDesc');
      let qtyDesc = expQtyDescInput ? expQtyDescInput.value.trim() : '';
      let packSizeVal = parseFloat(document.getElementById('expPackSize')?.value);
      let packUnitSelect = document.getElementById('expPackUnit');
      let customUnitInput = document.getElementById('expPackUnitCustom');
      let packUnit = packUnitSelect ? packUnitSelect.value : 'หน่วย';
      if (packUnit === 'CUSTOM' && customUnitInput && customUnitInput.value.trim()) {
        packUnit = customUnitInput.value.trim();
      } else if (!packUnit || packUnit === 'CUSTOM') {
        packUnit = 'หน่วย';
      }

      // Auto-extract packSize and packUnit from qtyDesc or title if not explicitly provided
      let packSize = (!isNaN(packSizeVal) && packSizeVal > 0) ? packSizeVal : 1;
      if (isNaN(packSizeVal) || packSizeVal <= 0) {
        const textToSearch = `${qtyDesc} ${title}`;
        const gMatch = textToSearch.match(/(\d+(\.\d+)?)\s*(g|กรัม)/i);
        const kgMatch = textToSearch.match(/(\d+(\.\d+)?)\s*(kg|กก|กิโลกรัม)/i);
        const canMatch = textToSearch.match(/(\d+(\.\d+)?)\s*(กป|กระป๋อง|can)/i);
        const cupMatch = textToSearch.match(/(\d+(\.\d+)?)\s*(ชุด|ใบ|แก้ว)/i);
        const botMatch = textToSearch.match(/(\d+(\.\d+)?)\s*(ขวด)/i);

        if (gMatch) {
          packSize = parseFloat(gMatch[1]);
          packUnit = 'g';
        } else if (kgMatch) {
          packSize = parseFloat(kgMatch[1]) * 1000;
          packUnit = 'g';
        } else if (canMatch) {
          packSize = parseFloat(canMatch[1]);
          packUnit = 'กระป๋อง';
        } else if (cupMatch) {
          packSize = parseFloat(cupMatch[1]);
          packUnit = 'ชุด';
        } else if (botMatch) {
          packSize = parseFloat(botMatch[1]);
          packUnit = 'ขวด';
        } else {
          const anyNum = textToSearch.match(/(\d+(\.\d+)?)/);
          packSize = anyNum ? parseFloat(anyNum[1]) : 1;
        }
      }

      if (!qtyDesc && packSize > 0) {
        qtyDesc = `${packSize} ${packUnit}`;
      }

      const expMinQtyVal = parseFloat(document.getElementById('expMinQty')?.value);
      const crateBottlesVal = parseFloat(document.getElementById('expCrateBottles')?.value);
      const isCrate = packUnit.includes('ลัง') || packUnit.toLowerCase() === 'crate';
      const crateBottles = isCrate ? (!isNaN(crateBottlesVal) && crateBottlesVal > 0 ? crateBottlesVal : 24) : null;
      const supplier = document.getElementById('expSupplier')?.value.trim() || '';
      const note = document.getElementById('expNote')?.value.trim() || '';

      const noAlertChecked = document.getElementById('expNoAlertCheckbox')?.checked || false;
      let effectiveMinQty = 0;
      if (noAlertChecked) {
        effectiveMinQty = 0;
      } else if (!isNaN(expMinQtyVal) && expMinQtyVal >= 0) {
        effectiveMinQty = expMinQtyVal;
      } else {
        effectiveMinQty = Math.max(1, Math.round(packSize * 0.25));
      }

      const expRecord = {
        date,
        title,
        category,
        amount,
        qtyDesc,
        packSize,
        packUnit,
        crateBottles,
        minQty: effectiveMinQty,
        supplier,
        note
      };

      if (!Array.isArray(this.data.expenses)) {
        this.data.expenses = [];
      }

      if (editId) {
        const idx = this.data.expenses.findIndex(x => x && String(x.id) === String(editId));
        if (idx !== -1) {
          const oldExp = { ...this.data.expenses[idx] };
          const updatedExp = { ...expRecord, id: this.data.expenses[idx].id, stockItemId: oldExp.stockItemId };
          this.updateExpenseInStock(oldExp, updatedExp);
          this.data.expenses[idx] = updatedExp;
        } else {
          const newExp = { ...expRecord, id: editId };
          this.addExpenseToStock(newExp);
          this.data.expenses.unshift(newExp);
        }
        this.showToast(`แก้ไขค่าใช้จ่าย & อัปเดตสต๊อก "${title}" สำเร็จ`, 'success');
      } else {
        const newExp = { ...expRecord, id: 'e_' + Date.now() };
        this.addExpenseToStock(newExp);
        this.data.expenses.unshift(newExp);
        const syncDesc = `+${newExp.packSize} ${newExp.packUnit}`;
        this.showToast(`บันทึกรายจ่าย & เติมเข้าสต๊อก "${title}" (${syncDesc}) เรียบร้อย!`, 'success');
      }

      this.saveData();
      this.syncRecipesWithExpenses();
      const expModal = document.getElementById('expenseModal');
      if (expModal) expModal.classList.remove('active');

      this.renderExpenses();
      this.renderRecipes();
      this.renderStock();
      this.renderLowStockAlertView();
      this.renderDashboard();
    } catch (err) {
      console.error('Error saving expense:', err);
      this.showToast('เกิดข้อผิดพลาดในการบันทึก: ' + err.message, 'danger');
    }
  }

  bindOtherForms() {
    // Expense Form Submit & Button Click
    const expenseForm = document.getElementById('expenseForm');
    const btnSaveExpense = document.getElementById('btnSaveExpense');

    if (expenseForm) {
      expenseForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleExpenseSubmit();
      });
    }

    if (btnSaveExpense) {
      btnSaveExpense.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleExpenseSubmit();
      });
    }

    // Recipe Form Submit
    const recipeForm = document.getElementById('recipeForm');
    if (recipeForm) {
      recipeForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const editId = document.getElementById('recipeEditId').value;
        const name = document.getElementById('recName').value.trim();
        const mode = document.getElementById('recMode')?.value || 'jar';
        const isCup = mode === 'cup';
        const jarLiters = isCup ? 0 : (parseFloat(document.getElementById('recJarLiters')?.value) || 6);
        const cupSizeOz = parseInt(document.getElementById('recCupSizeOz')?.value) || 16;
        const yieldCups = isCup ? 1 : (parseInt(document.getElementById('recYieldCups')?.value) || 25);
        const jarCapacity = isCup ? `แก้ว ${cupSizeOz} oz (1 แก้ว)` : (document.getElementById('recJarCapacity')?.value.trim() || `โหล/ถัง ${jarLiters} ลิตร (${yieldCups} แก้ว)`);
        const instructions = document.getElementById('recInstructions')?.value.trim() || '';

        const ingRows = document.querySelectorAll('#recipeIngredientsContainer .ingredient-row');
        const ingredients = [];
        ingRows.forEach(row => {
          const iName = row.querySelector('.ing-name').value.trim();
          const iAmountNum = row.querySelector('.ing-amount').value.trim();
          const iAmountUnit = (row.querySelector('.ing-amount-unit')?.value || '').trim();
          const iAmount = iAmountNum ? `${iAmountNum} ${iAmountUnit}`.trim() : '';
          const iCost = parseFloat(row.querySelector('.ing-cost').value) || 0;

          const pPrice = parseFloat(row.querySelector('.calc-pack-price')?.value) || 0;
          const pSize = parseFloat(row.querySelector('.calc-pack-size')?.value) || 0;
          const pUnit = row.querySelector('.calc-pack-unit')?.value.trim() || '';
          const pUse = parseFloat(row.querySelector('.calc-use-amount')?.value) || 0;
          const expSelect = row.querySelector('.calc-expense-select');
          const expenseId = expSelect ? expSelect.value : '';

          const item = { name: iName, amount: iAmount, cost: iCost };
          if (pPrice > 0 && pSize > 0) {
            item.calcData = {
              expenseId: expenseId || undefined,
              packPrice: pPrice,
              packSize: pSize,
              packUnit: pUnit,
              useAmount: pUse,
              originalAmountVal: parseFloat(iAmountNum) || 0,
              originalUnit: iAmountUnit || 'oz'
            };
          }

          if (iName) {
            ingredients.push(item);
          }
        });

        const totalCost = ingredients.reduce((sum, ing) => sum + (Number(ing.cost) || 0), 0);
        const unitCost = isCup ? totalCost : (yieldCups > 0 ? (totalCost / yieldCups) : 0);
        const sellingPrice = parseFloat(document.getElementById('recSellingPrice')?.value) || 25;
        const suggestedPrice = sellingPrice;

        // บันทึกรายการสัดส่วนน้ำชง 1 แก้วคู่กับสูตร (ถ้าเป็นโหมดแก้ว ใช้วัตถุดิบแก้วจาก ingredients ได้)
        const singleCupRows = document.querySelectorAll('#singleCupContainer .single-cup-row');
        const singleCupProportions = [];
        singleCupRows.forEach(crow => {
          const cName = crow.querySelector('.cup-ing-name')?.value.trim();
          const cAmt = parseFloat(crow.querySelector('.cup-ing-amount')?.value) || 0;
          const cUnit = crow.querySelector('.cup-ing-unit')?.value || 'oz';
          if (cName && cAmt > 0) {
            singleCupProportions.push({ name: cName, amount: cAmt, unit: cUnit });
          }
        });

        const recipeRecord = {
          name,
          mode,
          jarLiters,
          cupSizeOz,
          yieldCups,
          sellingPrice,
          suggestedPrice,
          jarCapacity,
          instructions,
          ingredients,
          singleCupProportions
        };

        if (editId) {
          const idx = this.data.recipes.findIndex(r => r.id === editId);
          if (idx !== -1) {
            this.data.recipes[idx] = { ...recipeRecord, id: editId };
          }
          this.showToast('แก้ไขสูตรชงน้ำเรียบร้อยแล้ว', 'success');
        } else {
          const newRec = { ...recipeRecord, id: 'r_' + Date.now() };
          this.data.recipes.unshift(newRec);
          this.showToast('บันทึกสูตรชงน้ำใหม่เรียบร้อยแล้ว', 'success');
        }

        this.saveData();
        document.getElementById('recipeModal').classList.remove('active');
        this.renderRecipes();
      });
    }

    // Stock Quick Add & Form Submit
    const btnStockQuickAdd = document.getElementById('btnStockQuickAdd');
    if (btnStockQuickAdd) {
      btnStockQuickAdd.addEventListener('click', () => this.openStockModal());
    }

    const btnSyncStock = document.getElementById('btnSyncStockFromExpenses');
    if (btnSyncStock) {
      btnSyncStock.addEventListener('click', () => this.syncStockFromExpenses());
    }

    const stockItemForm = document.getElementById('stockItemForm');
    if (stockItemForm) {
      stockItemForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveStockItem();
      });
    }
  }

  // ==========================================
  // Stock Management & Real-time Sync Methods
  // ==========================================

  renderStock() {
    const list = this.data.stockItems || [];
    const tbody = document.getElementById('stockTableBody');
    if (!tbody) return;

    let lowCount = 0;
    let normalCount = 0;
    let noAlertCount = 0;
    let totalValue = 0;

    list.forEach(item => {
      const minQty = Number(item.minQty) || 0;
      const isLow = minQty > 0 && Number(item.qty) <= minQty;
      if (minQty === 0) noAlertCount++;
      else if (isLow) lowCount++;
      else normalCount++;
      totalValue += (Number(item.qty) || 0) * (Number(item.unitCost) || 0);
    });

    // Update KPI Cards
    const kpiLow = document.getElementById('kpiStockLowCount');
    const kpiTotal = document.getElementById('kpiStockTotalItems');
    const kpiNormal = document.getElementById('kpiStockNormalCount');
    const kpiValue = document.getElementById('kpiStockTotalValue');

    if (kpiLow) kpiLow.textContent = `${lowCount} รายการ`;
    if (kpiTotal) kpiTotal.textContent = `${list.length} รายการ`;
    if (kpiNormal) kpiNormal.textContent = `${normalCount} รายการ`;
    if (kpiValue) kpiValue.textContent = this.formatCurrency(totalValue);

    // Update Sidebar Badges
    const stockAlertBadge = document.getElementById('stockAlertBadge');
    const stockLowCountBadge = document.getElementById('stockLowCountBadge');
    if (stockAlertBadge) {
      stockAlertBadge.textContent = `${lowCount} เตือน`;
      stockAlertBadge.style.display = lowCount > 0 ? 'inline-block' : 'none';
    }
    if (stockLowCountBadge) {
      stockLowCountBadge.textContent = String(lowCount);
      stockLowCountBadge.style.display = lowCount > 0 ? 'inline-block' : 'none';
    }

    // Update Filter labels
    const tabFilterAllText = document.getElementById('tabFilterAllText');
    const tabFilterLowText = document.getElementById('tabFilterLowText');
    if (tabFilterAllText) tabFilterAllText.textContent = `ทั้งหมด (${list.length})`;
    if (tabFilterLowText) tabFilterLowText.textContent = `⚠️ สินค้าใกล้หมด (${lowCount})`;

    if (list.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="text-center py-4 text-muted">
            ยังไม่มีสินค้าในสต๊อก กดปุ่ม <b>"+ เพิ่มสินค้าใหม่เข้าสต๊อก"</b> หรือ <b>"ซิงค์จากบิลซื้อของ"</b>
          </td>
        </tr>
      `;
      this.refreshLucide();
      return;
    }

    // Sort according to stockSortOrder (default: newest)
    const stockSort = document.getElementById('stockSortOrder')?.value || 'newest';
    const sorted = [...list].sort((a, b) => {
      const idA = String(a.id || '');
      const idB = String(b.id || '');
      const aMin = Number(a.minQty) || 0;
      const bMin = Number(b.minQty) || 0;
      const aPriority = (aMin > 0 && Number(a.qty) <= aMin) ? 0 : (aMin > 0 ? 1 : 2);
      const bPriority = (bMin > 0 && Number(b.qty) <= bMin) ? 0 : (bMin > 0 ? 1 : 2);

      if (stockSort === 'oldest') {
        return idA.localeCompare(idB);
      }
      if (stockSort === 'low_stock') {
        return aPriority - bPriority || a.name.localeCompare(b.name, 'th');
      }
      if (stockSort === 'name_asc') {
        return a.name.localeCompare(b.name, 'th');
      }
      // default: newest
      return idB.localeCompare(idA);
    });

    tbody.innerHTML = sorted.map(item => {
      const currentQty = Number(item.qty);
      const minQty = Number(item.minQty) || 0;
      const isNoAlert = (minQty === 0);
      const isLow = !isNoAlert && currentQty <= minQty;
      const unit = item.unit || 'หน่วย';
      const unitCost = Number(item.unitCost) || 0;
      const itemTotalVal = currentQty * unitCost;

      const catLabel = item.category === 'INGREDIENT' ? 'วัตถุดิบชง'
        : item.category === 'PACKAGING' ? 'บรรจุภัณฑ์'
          : item.category === 'STOCK' ? 'สำเร็จรูป/ลัง' : 'อื่นๆ';
      const catClass = item.category === 'INGREDIENT' ? 'blue-tag'
        : item.category === 'PACKAGING' ? 'orange-tag' : 'purple-tag';
      const catIcon = item.category === 'INGREDIENT' ? 'coffee'
        : item.category === 'PACKAGING' ? 'cup-soda' : 'package';

      const ratioPct = isNoAlert ? 100 : Math.min(100, Math.round((currentQty / Math.max(1, minQty * 2)) * 100));

      const statusTag = isNoAlert
        ? `<span class="pill-tag" style="font-size:0.75rem; font-weight:600; background:#f1f5f9; color:#64748b; border:1px solid #cbd5e1;">
            <i data-lucide="package-check" style="width:12px;height:12px;"></i> ของใช้ร้าน
           </span>`
        : isLow
          ? `<span class="pill-tag red-tag" style="font-weight:700; font-size:0.75rem; display:inline-flex; align-items:center; gap:0.25rem;">
              <i data-lucide="alert-triangle" style="width:12px;height:12px;"></i> ใกล้หมด
             </span>`
          : `<span class="pill-tag green-tag" style="font-size:0.75rem; font-weight:600;">
              <i data-lucide="check" style="width:12px;height:12px;"></i> ปกติ
             </span>`;

      return `
        <tr data-category="${this.escapeHtml(item.category)}" data-is-low="${isLow}" style="${isLow ? 'background:#fffbfb;' : ''}">
          <td>${statusTag}</td>
          <td>
            <div style="display:flex; align-items:center; gap:0.65rem;">
              <div style="width:34px; height:34px; background:${isLow ? '#fee2e2' : '#f1f5f9'}; border-radius:var(--radius-sm); display:flex; align-items:center; justify-content:center; color:${isLow ? '#dc2626' : 'var(--primary)'}; flex-shrink:0;">
                <i data-lucide="${catIcon}" style="width:18px;height:18px;"></i>
              </div>
              <div>
                <div class="font-bold text-main" style="font-size:0.95rem;">${this.escapeHtml(item.name)}</div>
                <div style="display:flex; align-items:center; gap:0.35rem; flex-wrap:wrap; margin-top:2px;">
                  ${(() => {
          if (!item.supplier) return '';
          const supInfo = this.parseSupplier(item.supplier);
          if (supInfo.isUrl) {
            return `<a href="${this.escapeHtml(supInfo.url)}" target="_blank" rel="noopener noreferrer" class="pill-tag orange-tag" style="font-size:0.7rem; padding:0.12rem 0.5rem; text-decoration:none; display:inline-flex; align-items:center; gap:0.25rem; background:#ffedd5; color:#c2410c; border:1px solid #fed7aa;" title="คลิกเพื่อเปิดลิ้งก์สั่งซื้อ ${this.escapeHtml(supInfo.domain)}">
                        🛒 ${this.escapeHtml(supInfo.name)} <i data-lucide="external-link" style="width:11px;height:11px;"></i>
                      </a>`;
          }
          return `<span class="pill-tag orange-tag" style="font-size:0.7rem; padding:0.1rem 0.45rem;">🛒 ${this.escapeHtml(item.supplier)}</span>`;
        })()}
                  ${item.note ? `<span class="text-xs text-muted">📍 ${this.escapeHtml(item.note)}</span>` : ''}
                </div>
              </div>
            </div>
          </td>
          <td><span class="pill-tag ${catClass}" style="font-size:0.75rem;">${catLabel}</span></td>
          <td style="text-align:center;">
            <div style="display:inline-flex; flex-direction:column; align-items:center; gap:0.25rem;">
              <div class="stock-qty-stepper">
                <button type="button" class="stock-stepper-btn minus" onclick="app.adjustStockQty('${item.id}', -1)" title="ลดลง 1">-</button>
                <div class="stock-qty-display ${isLow ? 'low' : ''}">
                  <input type="number" 
                         class="stock-qty-input" 
                         value="${currentQty}" 
                         min="0" 
                         step="any"
                         onfocus="this.select()"
                         onchange="app.setExactStockQty('${item.id}', this.value)"
                         onkeydown="if(event.key==='Enter'){this.blur();}"
                         title="คลิกเพื่อพิมพ์แก้ไขจำนวนคงเหลือโดยตรง">
                  <span class="stock-qty-unit-label">${this.escapeHtml(unit)}</span>
                </div>
                <button type="button" class="stock-stepper-btn plus" onclick="app.adjustStockQty('${item.id}', 1)" title="เพิ่ม 1">+</button>
              </div>
              <!-- Mini visual gauge -->
              <div style="width:100%; height:4px; background:#e2e8f0; border-radius:2px; overflow:hidden;">
                <div style="width:${Math.max(8, ratioPct)}%; height:100%; background:${isLow ? '#ef4444' : '#10b981'}; border-radius:2px;"></div>
              </div>
            </div>
          </td>
          <td>
            <div style="font-size:0.875rem;">
              ${isNoAlert
          ? `<span class="text-muted" title="ของใช้/ตกแต่งร้าน (ไม่ต้องเตือนสั่งซื้อ)">- (ไม่เตือน)</span>`
          : `<b style="color:${isLow ? 'var(--danger)' : 'var(--text-main)'};">${minQty}</b> <span class="text-xs text-muted">${this.escapeHtml(unit)}</span>`
        }
            </div>
          </td>
          <td>
            <div class="font-bold text-main" style="font-size:0.9rem;">${this.formatCurrency(unitCost)}</div>
            <div class="text-xs text-muted">ต่อ${this.escapeHtml(unit)}</div>
          </td>
          <td>
            <div class="font-bold ${isLow ? 'text-danger' : 'text-primary'}" style="font-size:1rem;">${this.formatCurrency(itemTotalVal)}</div>
          </td>
          <td class="text-center" style="white-space:nowrap;">
            <button class="btn-outline-fastwork btn-sm mr-1" onclick="app.openStockModal('${item.id}')" title="แก้ไขสต๊อก" style="padding:0.3rem 0.55rem;">
              <i data-lucide="edit-3" style="width:14px;height:14px;"></i>
            </button>
            <button class="icon-btn-border" onclick="app.deleteStockItem('${item.id}')" title="ลบรายการ" style="padding:0.3rem 0.55rem;">
              <i data-lucide="trash-2" style="width:14px;height:14px;color:var(--danger);"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');

    this.refreshLucide();
  }

  setStockFilter(type) {
    const radio = document.querySelector(`input[name="stockSubFilter"][value="${type}"]`);
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
    } else if (type === 'normal') {
      // Filter items where isLow is false
      const rows = document.querySelectorAll('#stockTableBody tr');
      rows.forEach(tr => {
        tr.style.display = (tr.dataset.isLow === 'false') ? '' : 'none';
      });
      document.querySelectorAll('input[name="stockSubFilter"]').forEach(r => r.checked = false);
    }
  }

  logStockAction(itemName, actionType, changeQty, currentQty, unit, note = '') {
    if (!Array.isArray(this.data.stockLogs)) {
      this.data.stockLogs = [];
    }

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dateStr = this.formatDate(now);

    const logEntry = {
      id: 'log_' + Date.now() + Math.random().toString(36).substring(2, 5),
      date: dateStr,
      time: timeStr,
      timestamp: Date.now(),
      itemName: itemName,
      actionType: actionType, // 'USE' (เบิก/ตัดสต๊อก), 'RESTOCK' (เติมสต๊อก), 'DIRECT_SET' (แก้ไขโดยตรง)
      changeQty: changeQty,
      resultingQty: currentQty,
      unit: unit,
      note: note
    };

    this.data.stockLogs.unshift(logEntry);
    // Keep last 150 log entries to keep storage clean
    if (this.data.stockLogs.length > 150) {
      this.data.stockLogs = this.data.stockLogs.slice(0, 150);
    }
  }

  setExactStockQty(itemId, val) {
    const item = (this.data.stockItems || []).find(x => x.id === itemId);
    if (!item) return;

    let parsed = parseFloat(val);
    if (isNaN(parsed) || parsed < 0) parsed = 0;

    const oldQty = Number(item.qty) || 0;
    if (oldQty === parsed) return;

    const diff = parsed - oldQty;
    item.qty = parsed;

    const actionType = diff > 0 ? 'RESTOCK' : 'USE';
    const note = `พิมพ์ปรับจำนวนจาก ${oldQty} เป็น ${parsed}`;
    this.logStockAction(item.name, actionType, diff, parsed, item.unit || '', note);

    this.saveData();
    this.renderStock();
    this.renderLowStockAlertView();
    this.renderDashboard();
    this.showToast(`ปรับยอดคงเหลือ "${item.name}" เป็น ${parsed} ${item.unit || ''} (บันทึกประวัติแล้ว)`, 'success');
  }

  adjustStockQty(itemId, delta) {
    const item = (this.data.stockItems || []).find(x => x.id === itemId);
    if (!item) return;

    const oldQty = Number(item.qty) || 0;
    const newQty = Math.max(0, oldQty + delta);
    if (oldQty === newQty) return;

    const actualDiff = newQty - oldQty;
    item.qty = newQty;

    const actionType = delta > 0 ? 'RESTOCK' : 'USE';
    const note = delta > 0 ? `กดเติมสต๊อก (+${delta})` : `กดเบิก/ตัดใช้สต๊อก (${delta})`;
    this.logStockAction(item.name, actionType, actualDiff, newQty, item.unit || '', note);

    this.saveData();
    this.renderStock();
    this.renderLowStockAlertView();
    this.renderDashboard();

    if (delta > 0) {
      this.showToast(`เติมสต๊อก ${item.name} +${delta} ${item.unit} (คงเหลือ ${newQty})`, 'success');
    } else {
      this.showToast(`ตัดสต๊อก ${item.name} ${delta} ${item.unit} (คงเหลือ ${newQty})`, 'info');
    }
  }

  renderStockHistory() {
    const tbody = document.getElementById('stockHistoryTableBody');
    const badge = document.getElementById('stockLogsCountBadge');
    const typeFilter = document.getElementById('stockLogTypeFilter')?.value || 'ALL';
    if (!tbody) return;

    let logs = this.data.stockLogs || [];
    if (badge) badge.textContent = `${logs.length} รายการ`;

    if (typeFilter !== 'ALL') {
      logs = logs.filter(l => l.actionType === typeFilter);
    }

    if (logs.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center text-muted py-4">
            ยังไม่มีประวัติการเบิก-ตัดสต๊อกในหมวดนี้ (เมื่อมีการกด + / - หรือพิมพ์ปรับยอด ระบบจะบันทึกอัตโนมัติ)
          </td>
        </tr>
      `;
      this.refreshLucide();
      return;
    }

    tbody.innerHTML = logs.map(log => {
      const isUse = log.actionType === 'USE';
      const typeBadge = isUse
        ? `<span class="pill-tag red-tag" style="font-weight:700; font-size:0.75rem;"><i data-lucide="arrow-down-circle" style="width:12px;height:12px;"></i> เบิก/ตัดใช้</span>`
        : `<span class="pill-tag green-tag" style="font-weight:700; font-size:0.75rem;"><i data-lucide="arrow-up-circle" style="width:12px;height:12px;"></i> เติมสต๊อก</span>`;

      const changeSign = log.changeQty > 0 ? `+${log.changeQty}` : `${log.changeQty}`;
      const changeClass = isUse ? 'text-danger' : 'text-green';

      return `
        <tr>
          <td>
            <div class="font-bold text-main" style="font-size:0.875rem;">${this.formatThaiDate(log.date)}</div>
            <div class="text-xs text-muted">⏰ ${log.time || '-'} น.</div>
          </td>
          <td>
            <div class="font-bold text-main" style="font-size:0.95rem;">${this.escapeHtml(log.itemName)}</div>
          </td>
          <td style="text-align:center;">${typeBadge}</td>
          <td style="text-align:right;">
            <span class="font-bold ${changeClass}" style="font-size:1.05rem;">${changeSign}</span>
            <span class="text-xs text-muted ml-1">${this.escapeHtml(log.unit || '')}</span>
          </td>
          <td style="text-align:right;">
            <b class="text-primary" style="font-size:1rem;">${log.resultingQty}</b>
            <span class="text-xs text-muted ml-1">${this.escapeHtml(log.unit || '')}</span>
          </td>
          <td>
            <div class="text-sm text-muted" style="line-height:1.4;">${this.formatLogNote(log.note || '-')}</div>
          </td>
        </tr>
      `;
    }).join('');

    this.refreshLucide();
  }

  clearStockHistory() {
    if (!this.data.stockLogs || this.data.stockLogs.length === 0) {
      this.showToast('ไม่มีประวัติการบันทึกให้ล้าง', 'info');
      return;
    }

    if (confirm('คุณต้องการล้างประวัติการเบิก-ตัดสต๊อกทั้งหมดใช่หรือไม่? (ยอดสต๊อกปัจจุบันจะไม่ถูกลบ)')) {
      this.data.stockLogs = [];
      this.saveData();
      this.renderStockHistory();
      this.showToast('ล้างประวัติการเบิก-ตัดสต๊อกเรียบร้อยแล้ว', 'info');
    }
  }

  // Format log note: Detects [ซื้อจาก: https://...] or raw URLs and shortens them to a tidy clickable badge
  formatLogNote(noteStr) {
    if (!noteStr) return '-';

    // Regex to match URLs (standalone or inside brackets)
    const urlPattern = /(https?:\/\/[^\s\]\)\>]+)/g;

    return noteStr.split(urlPattern).map(part => {
      if (part.match(/^https?:\/\//i)) {
        const parsed = this.parseSupplier(part);
        const shortLabel = parsed.name || (part.length > 28 ? part.substring(0, 25) + '...' : part);
        return `<a href="${this.escapeHtml(part)}" target="_blank" rel="noopener noreferrer"
                   class="pill-tag orange-tag"
                   style="font-size:0.7rem; font-weight:700; padding:0.1rem 0.45rem; text-decoration:none; display:inline-flex; align-items:center; gap:0.2rem; background:#ffedd5; color:#c2410c; border:1px solid #fed7aa; margin:1px 2px; vertical-align:middle;"
                   title="${this.escapeHtml(part)}">
                  🔗 ${this.escapeHtml(shortLabel)} <i data-lucide="external-link" style="width:10px;height:10px;"></i>
                </a>`;
      }
      return this.escapeHtml(part);
    }).join('');
  }

  openStockModal(itemId = null) {
    const modal = document.getElementById('stockItemModal');
    const form = document.getElementById('stockItemForm');
    const title = document.getElementById('stockItemModalTitle');
    if (!modal || !form) return;

    form.reset();
    document.getElementById('stockItemId').value = '';

    const noAlertCb = document.getElementById('stockItemNoAlertCheckbox');
    const minInput = document.getElementById('stockItemMin');

    if (itemId) {
      const item = (this.data.stockItems || []).find(x => x.id === itemId);
      if (item) {
        if (title) title.textContent = `แก้ไขสต๊อก: ${item.name}`;
        document.getElementById('stockItemId').value = item.id;
        document.getElementById('stockItemName').value = item.name;
        document.getElementById('stockItemCategory').value = item.category || 'INGREDIENT';
        document.getElementById('stockItemUnit').value = item.unit || 'กระป๋อง';
        document.getElementById('stockItemQty').value = item.qty;
        const currentMin = item.minQty !== undefined ? Number(item.minQty) : 5;
        if (minInput) {
          minInput.value = currentMin;
          minInput.disabled = (currentMin === 0);
          minInput.style.opacity = (currentMin === 0) ? '0.45' : '1';
        }
        if (noAlertCb) {
          noAlertCb.checked = (currentMin === 0);
        }
        document.getElementById('stockItemCost').value = item.unitCost;
        const supEl = document.getElementById('stockItemSupplier');
        if (supEl) supEl.value = item.supplier || '';
        document.getElementById('stockItemNote').value = item.note || '';
      }
    } else {
      if (title) title.textContent = 'เพิ่มสินค้าเข้าสต๊อกร้าน';
      document.getElementById('stockItemQty').value = 10;
      if (minInput) {
        minInput.value = 5;
        minInput.disabled = false;
        minInput.style.opacity = '1';
      }
      if (noAlertCb) {
        noAlertCb.checked = false;
      }
      document.getElementById('stockItemCost').value = 25;
      const supEl = document.getElementById('stockItemSupplier');
      if (supEl) supEl.value = '';
    }

    if (noAlertCb) {
      noAlertCb.onchange = () => {
        if (noAlertCb.checked) {
          if (minInput) {
            minInput.dataset.prevVal = minInput.value || '5';
            minInput.value = 0;
            minInput.disabled = true;
            minInput.style.opacity = '0.45';
          }
        } else {
          if (minInput) {
            const restored = parseFloat(minInput.dataset.prevVal) || 5;
            minInput.value = restored > 0 ? restored : 5;
            minInput.disabled = false;
            minInput.style.opacity = '1';
          }
        }
        this.updateStockModalPreview();
      };
    }

    this.updateStockModalPreview();

    // Wire live preview calculation listeners
    ['stockItemQty', 'stockItemMin', 'stockItemCost'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.oninput = () => this.updateStockModalPreview();
    });

    modal.classList.add('active');
    this.refreshLucide();
  }

  updateStockModalPreview() {
    const qty = parseFloat(document.getElementById('stockItemQty')?.value) || 0;
    const noAlertCb = document.getElementById('stockItemNoAlertCheckbox');
    const minInput = document.getElementById('stockItemMin');
    const isNoAlert = (noAlertCb && noAlertCb.checked) || (parseFloat(minInput?.value) === 0);
    const min = isNoAlert ? 0 : (parseFloat(minInput?.value) || 0);
    const cost = parseFloat(document.getElementById('stockItemCost')?.value) || 0;
    const totalVal = qty * cost;

    const valEl = document.getElementById('stockModalTotalValuePreview');
    const statusEl = document.getElementById('stockModalStatusPreview');

    if (valEl) valEl.textContent = this.formatCurrency(totalVal);
    if (statusEl) {
      if (isNoAlert) {
        statusEl.textContent = '📦 ของใช้/ตกแต่ง (ไม่เตือนซื้อ)';
        statusEl.className = 'pill-tag blue-tag';
        statusEl.style.fontSize = '0.75rem';
        statusEl.style.fontWeight = '700';
      } else if (qty <= min) {
        statusEl.textContent = '⚠️ ใกล้หมด (ต่ำกว่าเกณฑ์)';
        statusEl.className = 'pill-tag red-tag';
        statusEl.style.fontSize = '0.75rem';
        statusEl.style.fontWeight = '700';
      } else {
        statusEl.textContent = '✅ สต๊อกปลอดภัย';
        statusEl.className = 'pill-tag green-tag';
        statusEl.style.fontSize = '0.75rem';
        statusEl.style.fontWeight = '700';
      }
    }
  }

  saveStockItem() {
    const id = document.getElementById('stockItemId').value;
    const name = document.getElementById('stockItemName').value.trim();
    const category = document.getElementById('stockItemCategory').value;
    const unit = document.getElementById('stockItemUnit').value.trim() || 'หน่วย';
    const qty = parseFloat(document.getElementById('stockItemQty').value) || 0;
    const noAlertCb = document.getElementById('stockItemNoAlertCheckbox');
    const minQty = (noAlertCb && noAlertCb.checked) ? 0 : (parseFloat(document.getElementById('stockItemMin').value) || 0);
    const unitCost = parseFloat(document.getElementById('stockItemCost').value) || 0;
    const supplier = document.getElementById('stockItemSupplier')?.value.trim() || '';
    const note = document.getElementById('stockItemNote').value.trim();

    if (!name) {
      this.showToast('กรุณาระบุชื่อสินค้า', 'error');
      return;
    }

    if (!Array.isArray(this.data.stockItems)) {
      this.data.stockItems = [];
    }

    let savedItem = null;
    let isNew = false;

    if (id) {
      const idx = this.data.stockItems.findIndex(x => x.id === id);
      if (idx !== -1) {
        const oldItem = { ...this.data.stockItems[idx] };
        savedItem = { id, name, category, unit, qty, minQty, unitCost, supplier, note };
        this.data.stockItems[idx] = savedItem;
        this.syncStockToExpenses(savedItem, oldItem);
        this.showToast(`แก้ไขสต๊อก "${name}" และอัปเดตบันทึกต้นทุนเรียบร้อย`, 'success');
      }
    } else {
      isNew = true;
      savedItem = {
        id: 'stk_' + Date.now(),
        name,
        category,
        unit,
        qty,
        minQty,
        unitCost,
        supplier,
        note
      };
      this.data.stockItems.unshift(savedItem);
      this.syncStockToExpenses(savedItem, null, true);
      this.showToast(`เพิ่ม "${name}" เข้าสู่สต๊อกและบันทึกต้นทุนแล้ว`, 'success');
    }

    this.saveData();
    this.syncRecipesWithExpenses();
    document.getElementById('stockItemModal').classList.remove('active');
    this.renderStock();
    this.renderLowStockAlertView();
    this.renderExpenses();
    this.renderRecipes();
    this.calculatePricing();
    this.renderDashboard();
  }

  // ซิงค์การแก้ไขข้อมูลสต๊อกสินค้า -> รายการค่าใช้จ่าย & ต้นทุนวัตถุดิบ (Expenses)
  syncStockToExpenses(stockItem, oldItem = null, isNew = false) {
    if (!stockItem) return;
    if (!Array.isArray(this.data.expenses)) {
      this.data.expenses = [];
    }

    const stockNameClean = String(stockItem.name || '').split('(')[0].trim().toLowerCase();
    const oldNameClean = oldItem ? String(oldItem.name || '').split('(')[0].trim().toLowerCase() : '';

    // ค้นหารายการค่าใช้จ่ายที่เชื่อมโยงกับสินค้านี้
    const matchedExpenses = this.data.expenses.filter(exp => {
      if (!exp) return false;
      if (exp.stockItemId && String(exp.stockItemId) === String(stockItem.id)) return true;
      if (exp.title) {
        const expClean = String(exp.title).split('(')[0].trim().toLowerCase();
        const expLower = String(exp.title).toLowerCase();
        if (stockItem.name && (expLower === String(stockItem.name).toLowerCase() || expClean === stockNameClean)) return true;
        if (oldItem && oldItem.name && (expLower === String(oldItem.name).toLowerCase() || expClean === oldNameClean)) return true;
      }
      return false;
    });

    if (matchedExpenses.length > 0) {
      // ตรวจสอบว่าจำนวนสินค้าในสต๊อกมีการแก้ไขหรือไม่
      const isQtyChanged = oldItem && oldItem.qty !== stockItem.qty;

      matchedExpenses.forEach(exp => {
        // ผูก stockItemId ให้ตรงกัน
        exp.stockItemId = stockItem.id;
        exp.title = stockItem.name;
        exp.category = stockItem.category || exp.category;
        exp.packUnit = stockItem.unit || exp.packUnit;
        if (stockItem.supplier !== undefined) exp.supplier = stockItem.supplier;
        if (stockItem.minQty !== undefined) exp.minQty = stockItem.minQty;

        // หากเป็นการแก้ไขจำนวนคงเหลือในสต๊อก (และเป็นบิลที่ผูกกัน)
        if (isQtyChanged && stockItem.qty >= 0) {
          // หากมีบิลเดียว หรือจำนวนเดิมตรงกัน ให้ปรับจำนวนรับเข้า/ขนาดแพ็คตามสต๊อก
          if (matchedExpenses.length === 1 || Number(exp.packSize) === Number(oldItem.qty)) {
            exp.packSize = stockItem.qty;
            exp.qtyDesc = `${stockItem.qty} ${stockItem.unit}`;
          }
        }

        // ปรับยอดเงินรวม amount ตามราคาต่อหน่วยใหม่ (amount = unitCost * packSize)
        const packSize = Number(exp.packSize) || 1;
        if (stockItem.unitCost > 0) {
          exp.amount = parseFloat((stockItem.unitCost * packSize).toFixed(2));
        }
      });
    } else if (isNew && stockItem.qty > 0 && stockItem.unitCost > 0) {
      // ถ้าเป็นการสร้างสต๊อกใหม่ที่ยังไม่มีบิลค่าใช้จ่าย ให้สร้างบันทึกต้นทุนอัตโนมัติ
      const totalAmount = parseFloat((stockItem.unitCost * stockItem.qty).toFixed(2));
      const todayStr = this.formatDate(new Date());
      const newExp = {
        id: 'e_' + Date.now(),
        date: todayStr,
        title: stockItem.name,
        category: stockItem.category || 'INGREDIENT',
        amount: totalAmount,
        qtyDesc: `${stockItem.qty} ${stockItem.unit}`,
        packSize: stockItem.qty,
        packUnit: stockItem.unit,
        crateBottles: stockItem.unit.includes('ลัง') ? 24 : null,
        minQty: stockItem.minQty,
        supplier: stockItem.supplier || '',
        note: stockItem.note || 'บันทึกอัตโนมัติจากการเพิ่มสินค้าสต๊อก',
        stockItemId: stockItem.id
      };
      this.data.expenses.unshift(newExp);
    }
  }

  deleteStockItem(itemId) {
    const item = (this.data.stockItems || []).find(x => x.id === itemId);
    if (!item) return;
    if (confirm(`คุณต้องการลบ "${item.name}" ออกจากสต๊อกใช่หรือไม่?`)) {
      this.data.stockItems = this.data.stockItems.filter(x => x.id !== itemId);

      // ปลดการเชื่อมโยง stockItemId ใน expenses (คงประวัติค่าใช้จ่ายไว้ แต่ไม่ผูกกับสต๊อกนี้อีก)
      if (Array.isArray(this.data.expenses)) {
        this.data.expenses.forEach(exp => {
          if (exp && String(exp.stockItemId) === String(itemId)) {
            delete exp.stockItemId;
          }
        });
      }

      this.saveData();
      this.syncRecipesWithExpenses();
      this.showToast(`ลบรายการ "${item.name}" แล้ว`, 'info');
      this.renderStock();
      this.renderLowStockAlertView();
      this.renderExpenses();
      this.renderRecipes();
      this.calculatePricing();
      this.renderDashboard();
    }
  }

  // ซิงค์การบันทึกรายจ่ายเข้าสู่สต๊อกสินค้าทันที (+ เพิ่มจำนวนสต๊อก)
  addExpenseToStock(exp) {
    if (!Array.isArray(this.data.stockItems)) {
      this.data.stockItems = [];
    }

    const expTitleClean = String(exp.title || '').split('(')[0].trim().toLowerCase();
    let match = this.data.stockItems.find(s => {
      if (!s || !s.name) return false;
      if (exp.stockItemId && String(s.id) === String(exp.stockItemId)) return true;
      const sNameClean = String(s.name).split('(')[0].trim().toLowerCase();
      const sNameLower = String(s.name).toLowerCase();
      const expTitleLower = String(exp.title || '').toLowerCase();
      return sNameLower === expTitleLower || sNameClean === expTitleClean || sNameClean.includes(expTitleClean) || expTitleClean.includes(sNameClean);
    });

    const rawPackSize = Number(exp.packSize) || 1;
    const isCrate = (exp.packUnit || '').includes('ลัง') || (exp.packUnit || '').toLowerCase() === 'crate';
    const crateBottles = isCrate ? (Number(exp.crateBottles) > 0 ? Number(exp.crateBottles) : 24) : 1;

    // Effective inventory stock quantity & unit (บันทึกหน่วยตามที่ผู้ใช้เลือกรับเข้า เช่น ลัง ก็คงเป็น ลัง)
    const stockQty = rawPackSize;
    const stockUnit = exp.packUnit || 'หน่วย';
    const unitCost = stockQty > 0 ? (Number(exp.amount) / stockQty) : Number(exp.amount);
    const minThreshold = (exp.minQty !== undefined && exp.minQty !== null && exp.minQty !== '')
      ? Number(exp.minQty)
      : Math.max(1, Math.round(stockQty * 0.25));

    if (match) {
      // มีสินค้าอยู่แล้ว -> เติมจำนวนคงเหลือเพิ่มขึ้น และอัปเดตราคาต้นทุนเฉลี่ย
      const oldQty = Number(match.qty) || 0;
      const newQty = oldQty + stockQty;
      match.qty = newQty;
      match.unitCost = parseFloat(unitCost.toFixed(2));
      match.unit = stockUnit;
      match.minQty = minThreshold;
      if (exp.supplier) {
        match.supplier = exp.supplier;
      }

      const supText = exp.supplier ? ` [ซื้อจาก: ${exp.supplier}]` : '';
      const logNote = isCrate
        ? `รับเข้าของ ${rawPackSize} ลัง (บรรจุ ${crateBottles} ขวด/ลัง) จากบิลซื้อ (${this.formatThaiDate(exp.date)})${supText}`
        : `รับเข้าของจากบิลซื้อ (${this.formatThaiDate(exp.date)})${supText}`;
      this.logStockAction(match.name, 'RESTOCK', stockQty, newQty, match.unit || '', logNote);
      exp.stockItemId = match.id;
    } else {
      // ยังไม่มีในสต๊อก -> เพิ่มเป็นสินค้าคงคลังรายการใหม่ทันที
      const newItem = {
        id: 'stk_' + Date.now() + Math.random().toString(36).substring(2, 5),
        name: exp.title || 'สินค้าใหม่',
        category: exp.category || (isCrate ? 'STOCK' : 'INGREDIENT'),
        unit: stockUnit,
        qty: stockQty,
        minQty: minThreshold,
        unitCost: parseFloat(unitCost.toFixed(2)),
        supplier: exp.supplier || '',
        note: isCrate ? `รับเข้า ${rawPackSize} ลัง (${crateBottles} ขวด/ลัง) จากบิลซื้อ (${this.formatThaiDate(exp.date)})` : `รับเข้าจากบิลซื้อ (${this.formatThaiDate(exp.date)})`
      };
      this.data.stockItems.unshift(newItem);
      const supText = exp.supplier ? ` [ซื้อจาก: ${exp.supplier}]` : '';
      this.logStockAction(newItem.name, 'RESTOCK', stockQty, stockQty, newItem.unit, `เพิ่มรายการใหม่จากบิลซื้อ (${this.formatThaiDate(exp.date)})${supText}`);
      exp.stockItemId = newItem.id;
    }
  }

  // ซิงค์การแก้ไขรายจ่ายเข้าสู่สต๊อกสินค้า (อัปเดตจำนวน, ต้นทุน, เกณฑ์เตือนซื้อ, ร้านค้า, ชื่อสินค้า)
  updateExpenseInStock(oldExp, updatedExp) {
    if (!Array.isArray(this.data.stockItems)) {
      this.data.stockItems = [];
    }

    // หา stock item เดิมที่ตรงกับ oldExp
    let match = null;
    if (oldExp && oldExp.stockItemId) {
      match = this.data.stockItems.find(s => s && String(s.id) === String(oldExp.stockItemId));
    }
    if (!match && oldExp && oldExp.title) {
      const oldTitleClean = String(oldExp.title).split('(')[0].trim().toLowerCase();
      match = this.data.stockItems.find(s => {
        if (!s || !s.name) return false;
        const sClean = String(s.name).split('(')[0].trim().toLowerCase();
        const sNameLower = String(s.name).toLowerCase();
        const oldTitleLower = String(oldExp.title).toLowerCase();
        return sNameLower === oldTitleLower || sClean === oldTitleClean || sClean.includes(oldTitleClean) || oldTitleClean.includes(sClean);
      });
    }
    if (!match && updatedExp && updatedExp.title) {
      const newTitleClean = String(updatedExp.title).split('(')[0].trim().toLowerCase();
      match = this.data.stockItems.find(s => {
        if (!s || !s.name) return false;
        const sClean = String(s.name).split('(')[0].trim().toLowerCase();
        const sNameLower = String(s.name).toLowerCase();
        const newTitleLower = String(updatedExp.title).toLowerCase();
        return sNameLower === newTitleLower || sClean === newTitleClean || sClean.includes(newTitleClean) || newTitleClean.includes(sClean);
      });
    }

    if (!match) {
      // หากยังไม่มีสต๊อกรายการนี้ ให้เพิ่มเข้าสต๊อกใหม่ทันที
      this.addExpenseToStock(updatedExp);
      return;
    }

    const oldPackSize = Number(oldExp ? oldExp.packSize : 1) || 1;
    const newPackSize = Number(updatedExp ? updatedExp.packSize : 1) || 1;
    const diffQty = newPackSize - oldPackSize;
    const isCrate = (updatedExp.packUnit || '').includes('ลัง') || (updatedExp.packUnit || '').toLowerCase() === 'crate';

    const unitCost = newPackSize > 0 ? (Number(updatedExp.amount) / newPackSize) : Number(updatedExp.amount);
    const minThreshold = (updatedExp.minQty !== undefined && updatedExp.minQty !== null && updatedExp.minQty !== '')
      ? Number(updatedExp.minQty)
      : Math.max(1, Math.round(newPackSize * 0.25));

    // ตรวจสอบว่ามีการเปลี่ยนชื่อไปตรงกับสต๊อกรายการอื่นหรือไม่
    const newTitleClean = String(updatedExp.title || '').split('(')[0].trim().toLowerCase();
    const anotherMatch = this.data.stockItems.find(s => {
      if (!s || !s.name || (match && String(s.id) === String(match.id))) return false;
      const sClean = String(s.name).split('(')[0].trim().toLowerCase();
      const sNameLower = String(s.name).toLowerCase();
      const newTitleLower = String(updatedExp.title || '').toLowerCase();
      return sNameLower === newTitleLower || sClean === newTitleClean;
    });

    if (anotherMatch) {
      // ผู้ใช้เปลี่ยนชื่อบิลไปตรงกับสินค้าตัวอื่นที่มีอยู่แล้ว -> ตัดยอดออกจากตัวเดิม แล้วย้ายไปบวกที่ตัวใหม่
      const prevQty = Number(match.qty) || 0;
      match.qty = Math.max(0, prevQty - oldPackSize);
      this.logStockAction(match.name, 'ADJUST', -oldPackSize, match.qty, match.unit || '', `ปรับแก้บิลซื้อ ย้ายรายการไปที่ "${anotherMatch.name}"`);

      const anotherPrevQty = Number(anotherMatch.qty) || 0;
      const anotherNewQty = anotherPrevQty + newPackSize;
      anotherMatch.qty = anotherNewQty;
      anotherMatch.unitCost = parseFloat(unitCost.toFixed(2));
      anotherMatch.minQty = minThreshold;
      if (updatedExp.supplier) anotherMatch.supplier = updatedExp.supplier;
      if (updatedExp.packUnit) anotherMatch.unit = updatedExp.packUnit;
      if (updatedExp.category) anotherMatch.category = updatedExp.category;

      this.logStockAction(anotherMatch.name, 'RESTOCK', newPackSize, anotherNewQty, anotherMatch.unit || '', `รับเข้าจากการแก้ไขบิลซื้อ (${this.formatThaiDate(updatedExp.date)})`);
      updatedExp.stockItemId = anotherMatch.id;
    } else {
      // รายการเดิม -> อัปเดตข้อมูลทั้งหมดตามที่แก้ไข
      const currentQty = Number(match.qty) || 0;
      const newQty = Math.max(0, currentQty + diffQty);
      match.name = updatedExp.title || match.name;
      match.qty = newQty;
      match.unitCost = parseFloat(unitCost.toFixed(2));
      match.unit = updatedExp.packUnit || match.unit || 'หน่วย';
      match.category = updatedExp.category || match.category || (isCrate ? 'STOCK' : 'INGREDIENT');
      match.minQty = minThreshold;
      if (updatedExp.supplier !== undefined) {
        match.supplier = updatedExp.supplier;
      }

      const supText = updatedExp.supplier ? ` [ร้าน: ${updatedExp.supplier}]` : '';
      const diffText = diffQty !== 0 ? ` (ปรับจำนวน ${diffQty >= 0 ? '+' : ''}${diffQty} ${match.unit} คงเหลือ ${newQty})` : '';
      const logNote = `แก้ไขบิลซื้อ & สต๊อก${diffText} ทุน ฿${match.unitCost}/${match.unit} เกณฑ์เตือน ${match.minQty}${supText}`;
      this.logStockAction(match.name, 'ADJUST', diffQty, newQty, match.unit || '', logNote);
      updatedExp.stockItemId = match.id;
    }
  }

  // หักสต๊อกเมื่อมีการลบรายการค่าใช้จ่าย
  removeExpenseFromStock(exp) {
    if (!Array.isArray(this.data.stockItems) || !exp) return;
    const packSize = Number(exp.packSize) || 1;
    let match = null;
    if (exp.stockItemId) {
      match = this.data.stockItems.find(s => s && String(s.id) === String(exp.stockItemId));
    }
    if (!match && exp.title) {
      const expTitleClean = String(exp.title).split('(')[0].trim().toLowerCase();
      match = this.data.stockItems.find(s => {
        if (!s || !s.name) return false;
        const sClean = String(s.name).split('(')[0].trim().toLowerCase();
        const sNameLower = String(s.name).toLowerCase();
        const expTitleLower = String(exp.title).toLowerCase();
        return sNameLower === expTitleLower || sClean === expTitleClean || sClean.includes(expTitleClean) || expTitleClean.includes(sClean);
      });
    }

    if (match) {
      const oldQty = Number(match.qty) || 0;
      const newQty = Math.max(0, oldQty - packSize);
      match.qty = newQty;
      this.logStockAction(match.name, 'ADJUST', -packSize, newQty, match.unit || '', `หักสต๊อกจากลบบิลซื้อ (${this.formatThaiDate(exp.date)})`);
    }
  }

  // ซิงค์ยอดซื้อจากรายการค่าใช้จ่ายเข้าสู่ระบบสต๊อกอัตโนมัติ (Manual trigger)
  syncStockFromExpenses() {
    const expenses = this.data.expenses || [];
    if (!Array.isArray(this.data.stockItems)) {
      this.data.stockItems = [];
    }

    let syncedCount = 0;

    expenses.forEach(exp => {
      if (!exp || !exp.title) return;
      const expTitleClean = String(exp.title).split('(')[0].trim().toLowerCase();
      let match = this.data.stockItems.find(s => {
        if (!s || !s.name) return false;
        if (exp.stockItemId && String(s.id) === String(exp.stockItemId)) return true;
        const sNameClean = String(s.name).split('(')[0].trim().toLowerCase();
        const sNameLower = String(s.name).toLowerCase();
        const expTitleLower = String(exp.title).toLowerCase();
        return sNameLower === expTitleLower || sNameClean === expTitleClean || sNameClean.includes(expTitleClean) || expTitleClean.includes(sNameClean);
      });

      const packSize = Number(exp.packSize) || 1;
      const unitCost = packSize > 0 ? (Number(exp.amount) / packSize) : Number(exp.amount);

      const effectiveMin = (exp.minQty !== undefined && exp.minQty !== null && exp.minQty !== '')
        ? Number(exp.minQty)
        : Math.max(1, Math.round(packSize * 0.25));

      if (match) {
        match.unitCost = parseFloat(unitCost.toFixed(2));
        if (exp.supplier && !match.supplier) match.supplier = exp.supplier;
        if (exp.minQty !== undefined && exp.minQty !== null && exp.minQty !== '') match.minQty = Number(exp.minQty);
        if (exp.packUnit && (!match.unit || match.unit === 'หน่วย')) match.unit = exp.packUnit;
        if (!exp.stockItemId) exp.stockItemId = match.id;
        syncedCount++;
      } else {
        const newItem = {
          id: 'stk_' + Date.now() + Math.random().toString(36).substring(2, 5),
          name: exp.title,
          category: exp.category || 'INGREDIENT',
          unit: exp.packUnit || 'หน่วย',
          qty: packSize,
          minQty: effectiveMin,
          unitCost: parseFloat(unitCost.toFixed(2)),
          supplier: exp.supplier || '',
          note: `ซิงค์อัตโนมัติจากบิลซื้อ (${this.formatThaiDate(exp.date)})`
        };
        this.data.stockItems.push(newItem);
        exp.stockItemId = newItem.id;
        syncedCount++;
      }
    });

    this.saveData();
    this.renderStock();
    this.renderLowStockAlertView();
    this.renderDashboard();
    this.showToast(`ซิงค์ข้อมูลกับรายการซื้อของสำเร็จ (${syncedCount} รายการได้รับการเชื่อมโยง)`, 'success');
  }

  // Helper to parse supplier string: detects URLs (Shopee, Lazada, TikTok, Makro, etc.)
  parseSupplier(raw) {
    if (!raw || typeof raw !== 'string') {
      return { isUrl: false, name: '', url: '', domain: '' };
    }
    const trimmed = raw.trim();
    const urlPattern = /^(https?:\/\/|www\.)[^\s]+/i;
    const match = trimmed.match(urlPattern);

    if (match) {
      let fullUrl = match[0];
      if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
        fullUrl = 'https://' + fullUrl;
      }

      let domainName = '';
      try {
        const parsed = new URL(fullUrl);
        domainName = parsed.hostname.replace(/^www\./i, '');
      } catch (e) {
        domainName = fullUrl.replace(/https?:\/\//i, '').split('/')[0];
      }

      let brand = '';
      const dLower = domainName.toLowerCase();
      if (dLower.includes('shopee')) brand = 'Shopee';
      else if (dLower.includes('lazada')) brand = 'Lazada';
      else if (dLower.includes('tiktok')) brand = 'TikTok Shop';
      else if (dLower.includes('makro') || dLower.includes('makroclick')) brand = 'Makro (แม็คโคร)';
      else if (dLower.includes('lotuss') || dLower.includes('lotus')) brand = "Lotus's (โลตัส)";
      else if (dLower.includes('bigc')) brand = 'Big C';
      else if (dLower.includes('lineman') || dLower.includes('line.me')) brand = 'LINE / LINE MAN';
      else if (dLower.includes('facebook')) brand = 'Facebook';
      else brand = domainName;

      return {
        isUrl: true,
        name: brand,
        url: fullUrl,
        domain: domainName,
        displayLabel: `${brand} (เปิดลิ้งก์สั่งซื้อ)`
      };
    }

    return {
      isUrl: false,
      name: trimmed,
      url: '',
      domain: '',
      displayLabel: trimmed
    };
  }

  // ==========================================
  // Redesigned Low Stock Alert Page Rendering
  // ==========================================
  filterLowStockBySupplier(supplierKey) {
    if (this.currentLowStockSupplierFilter === supplierKey) {
      this.currentLowStockSupplierFilter = 'ALL';
    } else {
      this.currentLowStockSupplierFilter = supplierKey;
    }
    this.renderLowStockAlertView();
  }

  renderLowStockAlertView() {
    const list = this.data.stockItems || [];
    const container = document.getElementById('lowStockCardsContainer');
    if (!container) return;

    if (!this.currentLowStockSupplierFilter) {
      this.currentLowStockSupplierFilter = 'ALL';
    }

    // Filter only critical low-stock items (exclude items with minQty <= 0 which means no alert)
    const lowItems = list.filter(item => {
      const min = Number(item.minQty) || 0;
      return min > 0 && Number(item.qty) <= min;
    });

    let totalSuggestedQty = 0;
    let totalEstBudget = 0;
    const supplierMap = {};

    lowItems.forEach(item => {
      // แนะนำสั่งซื้อเท่ากับ (จุดปลอดภัย x 2 หรือเติมให้เต็มรอบ)
      const diff = Math.max(1, (Number(item.minQty) * 2) - Number(item.qty));
      const cost = diff * (Number(item.unitCost) || 0);
      totalSuggestedQty += diff;
      totalEstBudget += cost;

      // Group by supplier (clean brand/store name if URL)
      const rawSup = (item.supplier || '').trim();
      const supParsed = this.parseSupplier(rawSup);
      const supKey = supParsed.name || (rawSup || 'ไม่ระบุร้านค้า');
      if (!supplierMap[supKey]) {
        supplierMap[supKey] = { count: 0, items: [], budget: 0, url: supParsed.url, isUrl: supParsed.isUrl };
      }
      supplierMap[supKey].count += 1;
      supplierMap[supKey].items.push(item.name);
      supplierMap[supKey].budget += cost;
      if (!supplierMap[supKey].url && supParsed.url) {
        supplierMap[supKey].url = supParsed.url;
      }
    });

    // Update KPI Metric Highlights
    const countVal = document.getElementById('lowAlertCountVal');
    const qtyVal = document.getElementById('lowAlertSuggestedQty');
    const budgetVal = document.getElementById('lowAlertEstBudget');
    const badge = document.getElementById('lowAlertPendingBadge');
    const supplierChipsContainer = document.getElementById('lowAlertSupplierBreakdownChips');
    const filterIndicator = document.getElementById('lowStockFilterIndicator');
    const btnResetFilter = document.getElementById('btnResetLowStockFilter');

    if (countVal) countVal.textContent = `${lowItems.length} รายการ`;
    if (qtyVal) qtyVal.textContent = `${lowItems.length} รายการ (${totalSuggestedQty} หน่วย)`;
    if (budgetVal) budgetVal.textContent = this.formatCurrency(totalEstBudget);
    if (badge) {
      badge.textContent = lowItems.length > 0 ? `พบ ${lowItems.length} รายการที่ต้องสั่งด่วน` : 'สต๊อกปลอดภัยทุกรายการ';
      badge.className = lowItems.length > 0 ? 'pill-tag red-tag' : 'pill-tag green-tag';
    }

    // Render supplier breakdown chips in Card (clickable to filter)
    if (supplierChipsContainer) {
      const supKeys = Object.keys(supplierMap);
      if (supKeys.length === 0) {
        supplierChipsContainer.innerHTML = `<span class="text-xs" style="color:#b45309;">ไม่มีรายการต้องซื้อ</span>`;
      } else {
        const isAllActive = this.currentLowStockSupplierFilter === 'ALL';
        const allBtn = `
          <span onclick="app.filterLowStockBySupplier('ALL')"
            style="cursor:pointer; background:${isAllActive ? '#b45309' : '#fef3c7'}; color:${isAllActive ? '#ffffff' : '#92400e'}; padding:0.2rem 0.6rem; border-radius:var(--radius-full); font-size:0.75rem; font-weight:700; border:1px solid ${isAllActive ? '#92400e' : '#fde68a'}; display:inline-flex; align-items:center; gap:0.25rem; transition:all 0.15s;" title="แสดงทั้งหมดทุกร้าน">
            🛒 ทั้งหมด (${lowItems.length})
          </span>
        `;

        const chipsHtml = supKeys.map(k => {
          const info = supplierMap[k];
          const isSelected = this.currentLowStockSupplierFilter === k;
          const isKnownStore = k.toLowerCase().includes('makro') || k.toLowerCase().includes('shopee') || k.toLowerCase().includes('lazada') || k.toLowerCase().includes('lotus') || k.toLowerCase().includes('tiktok');
          const chipBg = isSelected ? '#ea580c' : (isKnownStore ? '#fed7aa' : '#fef08a');
          const chipColor = isSelected ? '#ffffff' : (isKnownStore ? '#9a3412' : '#854d0e');
          const chipBorder = isSelected ? '#c2410c' : (isKnownStore ? '#fdba74' : '#fde047');
          const escapedK = this.escapeHtml(k).replace(/'/g, "\\'");

          return `
            <span onclick="app.filterLowStockBySupplier('${escapedK}')"
              style="cursor:pointer; background:${chipBg}; color:${chipColor}; padding:0.2rem 0.6rem; border-radius:var(--radius-full); font-size:0.75rem; font-weight:700; border:1.5px solid ${chipBorder}; display:inline-flex; align-items:center; gap:0.25rem; box-shadow:0 1px 2px rgba(0,0,0,0.06); transition:all 0.15s; ${isSelected ? 'transform:scale(1.04);' : ''}"
              title="คลิกเพื่อกรองเฉพาะสินค้าที่ซื้อจาก ${this.escapeHtml(k)} (งบ: ฿${info.budget.toLocaleString()})">
              🛒 ${this.escapeHtml(k)}: <b style="text-decoration:underline;">${info.count} ชิ้น</b>
              ${info.isUrl ? ' 🔗' : ''}
              ${isSelected ? ' ✓' : ''}
            </span>
          `;
        }).join('');

        supplierChipsContainer.innerHTML = allBtn + chipsHtml;
      }
    }

    // Apply Filter to lowItems
    let displayedItems = lowItems;
    if (this.currentLowStockSupplierFilter && this.currentLowStockSupplierFilter !== 'ALL') {
      displayedItems = lowItems.filter(item => {
        const itemSup = (item.supplier || '').trim();
        const parsed = this.parseSupplier(itemSup);
        const nameToMatch = (parsed.name || itemSup || 'ไม่ระบุร้านค้า').toLowerCase();
        const filterTarget = this.currentLowStockSupplierFilter.toLowerCase();
        return nameToMatch === filterTarget ||
          nameToMatch.includes(filterTarget) ||
          filterTarget.includes(nameToMatch) ||
          itemSup.toLowerCase().includes(filterTarget);
      });

      if (filterIndicator) {
        filterIndicator.style.display = 'inline-flex';
        filterIndicator.innerHTML = `<span class="pill-tag orange-tag" style="font-weight:700; font-size:0.75rem; padding:0.2rem 0.55rem; background:#ffedd5; color:#c2410c; border:1.5px solid #fed7aa;">กรองเฉพาะ: 🛒 ${this.escapeHtml(this.currentLowStockSupplierFilter)} (${displayedItems.length} รายการ)</span>`;
      }
      if (btnResetFilter) btnResetFilter.style.display = 'inline-flex';
    } else {
      if (filterIndicator) filterIndicator.style.display = 'none';
      if (btnResetFilter) btnResetFilter.style.display = 'none';
    }

    // Bind Hero Actions
    const btnCopy = document.getElementById('btnExportShoppingList');
    if (btnCopy) {
      btnCopy.onclick = () => this.copyShoppingListToClipboard(displayedItems, supplierMap);
    }

    if (displayedItems.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem; background: #fffbeb; border: 1.5px dashed #fcd34d; border-radius: var(--radius-md);">
          <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">🔍</div>
          <h3 style="color: #92400e; font-weight: 800; font-size: 1.15rem;">ไม่พบสินค้าเตือนสั่งซื้อที่ซื้อจาก "${this.escapeHtml(this.currentLowStockSupplierFilter)}"</h3>
          <p style="color: #b45309; font-size: 0.9rem; margin-top: 0.25rem;">รายการสินค้าใกล้หมดอาจเป็นของแหล่งซื้ออื่น</p>
          <button class="btn-fastwork mt-3" onclick="app.filterLowStockBySupplier('ALL')">ดูสินค้าใกล้หมดทั้งหมด (${lowItems.length} รายการ)</button>
        </div>
      `;
      this.refreshLucide();
      return;
    }

    container.innerHTML = displayedItems.map(item => {
      const currentQty = Number(item.qty);
      const minQty = Number(item.minQty);
      const unit = item.unit || 'หน่วย';
      const unitCost = Number(item.unitCost) || 0;

      // คำนวณ % คงเหลือเทียบกับ minQty (0-100)
      const ratioPct = Math.min(100, Math.round((currentQty / Math.max(1, minQty)) * 100));
      // จำนวนแนะนำสั่งซื้อ
      const suggestedBuy = Math.max(1, (minQty * 2) - currentQty);
      const estCost = suggestedBuy * unitCost;

      const catLabel = item.category === 'INGREDIENT' ? 'วัตถุดิบชงน้ำ'
        : item.category === 'PACKAGING' ? 'บรรจุภัณฑ์'
          : item.category === 'STOCK' ? 'สำเร็จรูป/ลัง' : 'อื่นๆ';

      const supParsed = this.parseSupplier(item.supplier);

      let supplierBadgeHtml = `<span class="pill-tag" style="font-size:0.7rem; background:#f1f5f9; color:#64748b;">🛒 ยังไม่ระบุร้านซื้อ</span>`;
      let supplierActionBtn = '';
      let supplierInfoInBox = '';

      if (supParsed.name) {
        if (supParsed.isUrl) {
          supplierBadgeHtml = `
            <a href="${this.escapeHtml(supParsed.url)}" target="_blank" rel="noopener noreferrer"
              class="pill-tag orange-tag"
              style="font-size:0.7rem; font-weight:700; background:#ffedd5; color:#c2410c; border:1px solid #fed7aa; text-decoration:none; display:inline-flex; align-items:center; gap:0.25rem;"
              title="คลิกลิงก์เพื่อเปิดหน้าร้านค้า ${this.escapeHtml(supParsed.domain)}">
              🛒 ${this.escapeHtml(supParsed.name)}
              <i data-lucide="external-link" style="width:11px;height:11px;"></i>
            </a>
          `;
          supplierActionBtn = `
            <a href="${this.escapeHtml(supParsed.url)}" target="_blank" rel="noopener noreferrer"
              class="btn-outline-fastwork btn-sm"
              style="text-decoration:none; display:inline-flex; align-items:center; gap:0.3rem; color:#ea580c; border-color:#fdba74; background:#fff7ed; padding:0.5rem 0.75rem; font-size:0.8rem; font-weight:700;"
              title="เปิดลิงก์สั่งซื้อ ${this.escapeHtml(supParsed.name)} ทันที">
              <i data-lucide="external-link" style="width:13px;height:13px;"></i>
              <span>สั่งซื้อที่ ${this.escapeHtml(supParsed.name)}</span>
            </a>
          `;
          supplierInfoInBox = `
            <div style="color:#b45309; font-weight:600; display:flex; align-items:center; gap:0.35rem; flex-wrap:wrap;">
              <span>🏪 ลิ้งก์สั่งซื้อ:</span>
              <a href="${this.escapeHtml(supParsed.url)}" target="_blank" rel="noopener noreferrer" style="color:#ea580c; text-decoration:underline; font-weight:700; word-break:break-all;">
                ${this.escapeHtml(supParsed.name)} (${this.escapeHtml(supParsed.domain)}) 🔗
              </a>
            </div>
          `;
        } else {
          supplierBadgeHtml = `<span class="pill-tag orange-tag" style="font-size:0.7rem; font-weight:700; background:#ffedd5; color:#c2410c; border:1px solid #fed7aa;">🛒 ซื้อจาก: ${this.escapeHtml(supParsed.name)}</span>`;
          supplierInfoInBox = `<div style="color:#b45309; font-weight:600;">🏪 แหล่งซื้อ: <u>${this.escapeHtml(supParsed.name)}</u></div>`;
        }
      }

      return `
        <div class="low-stock-card">
          <div>
            <div class="low-stock-card-header">
              <div>
                <div style="display:flex; align-items:center; gap:0.35rem; margin-bottom:0.3rem; flex-wrap:wrap;">
                  <span class="pill-tag blue-tag" style="font-size:0.7rem;">${catLabel}</span>
                  ${supplierBadgeHtml}
                </div>
                <div class="low-stock-item-name">${this.escapeHtml(item.name)}</div>
              </div>
              <div class="low-stock-badge-critical">
                <i data-lucide="alert-triangle" style="width:13px;height:13px;"></i>
                <span>วิกฤต</span>
              </div>
            </div>

            <!-- Visual Stock Meter -->
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; margin-top:0.4rem;">
              <span class="text-muted">ระดับสต๊อกปัจจุบัน:</span>
              <span class="font-bold text-danger">${currentQty} / ${minQty} ${this.escapeHtml(unit)}</span>
            </div>
            <div class="low-stock-meter">
              <div class="low-stock-meter-fill" style="width: ${Math.max(8, ratioPct)}%;"></div>
            </div>

            <div class="low-stock-metrics-row">
              <div>ต้นทุนเดิม: <b>${this.formatCurrency(unitCost)}</b>/${this.escapeHtml(unit)}</div>
              <div>เกณฑ์ขั้นต่ำ: <b>${minQty} ${this.escapeHtml(unit)}</b></div>
            </div>

            <!-- Recommendation Alert Box -->
            <div class="low-stock-rec-box">
              <div style="font-weight: 700; color: #9a3412; display: flex; align-items: center; gap: 0.35rem; margin-bottom: 0.25rem;">
                <i data-lucide="shopping-cart" style="width: 14px; height: 14px;"></i>
                <span>แนะนำสั่งซื้อรอบนี้: +${suggestedBuy} ${this.escapeHtml(unit)}</span>
              </div>
              <div style="color: #c2410c; font-size: 0.775rem;">
                ประมาณการงบที่ต้องเตรียม: <b>${this.formatCurrency(estCost)}</b>
              </div>
              <div style="display:flex; flex-direction:column; gap:2px; margin-top:0.4rem; font-size:0.75rem;">
                ${supplierInfoInBox}
                ${item.note ? `<div style="color: #64748b; font-size: 0.72rem;">📍 ${this.escapeHtml(item.note)}</div>` : ''}
              </div>
            </div>
          </div>

          <!-- Action buttons for this specific item -->
          <div class="low-stock-card-actions" style="flex-wrap:wrap;">
            <button class="btn-fastwork-sm" style="flex:1; background:#dc2626; color:#ffffff; font-weight:700; justify-content:center;" onclick="app.quickRestockItem('${item.id}', ${suggestedBuy})">
              <i data-lucide="plus-circle"></i>
              <span>กดเติมทันที (+${suggestedBuy})</span>
            </button>
            ${supplierActionBtn}
            <button class="btn-outline-fastwork btn-sm" onclick="app.openStockModal('${item.id}')" title="แก้ไขสต๊อก / แหล่งซื้อ">
              <i data-lucide="settings-2" style="width:14px;height:14px;"></i>
            </button>
          </div>
        </div>
      `;
    }).join('');

    this.refreshLucide();
  }

  // Quick Restock right from the emergency card
  quickRestockItem(itemId, addQty) {
    const item = (this.data.stockItems || []).find(x => x.id === itemId);
    if (!item) return;

    const oldQty = Number(item.qty) || 0;
    const newQty = oldQty + addQty;
    item.qty = newQty;

    this.logStockAction(item.name, 'RESTOCK', addQty, newQty, item.unit || '', `กดเติมด่วนจากการ์ดสินค้าใกล้หมด (+${addQty})`);

    this.saveData();
    this.renderStock();
    this.renderLowStockAlertView();
    this.renderDashboard();
    this.showToast(`เติมสต๊อก ${item.name} +${addQty} ${item.unit} เรียบร้อยแล้ว!`, 'success');
  }

  // Copy structured list for LINE / Chat to suppliers
  copyShoppingListToClipboard(lowItems, supplierMap = null) {
    if (!lowItems || lowItems.length === 0) {
      this.showToast('ไม่มีรายการสินค้าที่ต้องสั่งซื้อในขณะนี้', 'info');
      return;
    }

    const shopTitle = (this.data.shopSettings && this.data.shopSettings.name) ? this.data.shopSettings.name : 'ร้านน้ำยายแต๊ป';
    let text = `📋 [ใบสั่งซื้อของด่วน - ${shopTitle}]\nประจำวันที่ ${this.formatThaiDate(this.formatDate(new Date()))}\n=========================\n`;
    let totalEst = 0;

    // Group items by supplier
    const grouped = {};
    lowItems.forEach(item => {
      const parsed = this.parseSupplier(item.supplier);
      const supTitle = parsed.name || 'ร้านค้าทั่วไป / อื่นๆ';
      if (!grouped[supTitle]) grouped[supTitle] = { items: [], url: parsed.url };
      grouped[supTitle].items.push({ item, parsed });
      if (!grouped[supTitle].url && parsed.url) {
        grouped[supTitle].url = parsed.url;
      }
    });

    Object.keys(grouped).forEach(sup => {
      const g = grouped[sup];
      text += `\n🛒 แหล่งซื้อ: ${sup}${g.url ? `\n🔗 ลิ้งก์ร้าน: ${g.url}` : ''}\n-------------------------\n`;
      g.items.forEach(({ item, parsed }) => {
        const minQty = Number(item.minQty);
        const currentQty = Number(item.qty);
        const suggestedBuy = Math.max(1, (minQty * 2) - currentQty);
        const est = suggestedBuy * (Number(item.unitCost) || 0);
        totalEst += est;
        const linkNote = parsed.isUrl ? ` [ลิ้งก์: ${parsed.url}]` : '';
        text += `  • ${item.name} สั่งเพิ่ม: ${suggestedBuy} ${item.unit || ''} (เหลือในร้าน: ${currentQty})${linkNote}\n`;
      });
    });

    text += `\n=========================\n💰 ประมาณการงบรวมทั้งหมด: ฿${totalEst.toLocaleString()}\n(ส่งจากระบบสต๊อกอัตโนมัติ)`;

    navigator.clipboard.writeText(text).then(() => {
      this.showToast('คัดลอกรายการสั่งซื้อพร้อมลิ้งก์ (สำหรับส่ง LINE) เรียบร้อย! 📋', 'success');
    }).catch(() => {
      prompt('คัดลอกรายการสั่งซื้อ:', text);
    });
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// Initialize Application
let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new WaterFlowApp();
  window.app = app;
});
