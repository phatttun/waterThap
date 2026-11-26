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
    vacationPeriods: []
  },
  dailySales: [],
  expenses: [],
  recipes: [],
  stockItems: [],
  stockLogs: [],
  savedProducts: [],
  customHolidays: [],
  drinkSalesLogs: []
};

class WaterFlowApp {
  constructor() {
    this.data = this.loadData();
    this.currentCalendarDate = new Date();
    this.selectedCalendarDayStr = this.formatDate(new Date());
    this.selectedStockProfitDate = this.formatDate(new Date());
    this.holidayPickerMonthDate = new Date();
    this.selectedBatchHolidayDates = new Set();
    this.charts = {
      trend: null,
      breakdown: null
    };
    this.currentStockFilter = 'all';

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
      // เคลียร์ค่าระบบเดิมที่อาจหลงเหลืออยู่ในเครื่องของผู้ใช้
      if (parsed.shopSettings.vacationMonths) {
        delete parsed.shopSettings.vacationMonths;
      }
      if (!Array.isArray(parsed.shopSettings.vacationPeriods)) {
        parsed.shopSettings.vacationPeriods = [];
      }
      if (!Array.isArray(parsed.savedProducts)) {
        parsed.savedProducts = [];
      }
      if (!Array.isArray(parsed.customHolidays)) {
        parsed.customHolidays = [];
      }
      if (!Array.isArray(parsed.drinkSalesLogs)) {
        parsed.drinkSalesLogs = [];
      }
      if (!Array.isArray(parsed.stockItems)) {
        parsed.stockItems = [];
      }
      const migrated = this.migrateData(parsed);
      if (migrated) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
      }
      return parsed;
    } catch (e) {
      console.error('Error parsing stored data, resetting:', e);
      this.saveData(DEFAULT_DATA, false);
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
  }

  migrateData(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;
    let changed = false;

    // Migration: แปลงสต๊อกที่เคยบันทึกเป็นหน่วยบรรจุ (ลัง/แพ็ค/กล่อง) ให้แสดงเป็นชิ้นย่อย (ขวด/ใบ/ชิ้น)
    if (Array.isArray(parsed.stockItems)) {
      parsed.stockItems.forEach(stk => {
        if (!stk) return;
        const crateBottles = Number(stk.crateBottles) || 0;
        if (crateBottles <= 1) return;
        const currentUnit = (stk.unit || '').trim();
        const isBulkUnit = currentUnit.includes('ลัง') || currentUnit.includes('แพ็ค') || currentUnit.includes('กล่อง') ||
          currentUnit.toLowerCase() === 'crate' || currentUnit.toLowerCase() === 'pack' || currentUnit.toLowerCase() === 'box';
        if (isBulkUnit) {
          const oldQty = Number(stk.qty) || 0;
          stk.qty = Math.round(oldQty * crateBottles * 100) / 100;
          const lowerName = String(stk.name || '').toLowerCase();
          if (lowerName.includes('แก้ว') || lowerName.includes('ฝา') || lowerName.includes('หลอด') || lowerName.includes('ถุงแก้ว')) {
            stk.unit = 'ใบ';
          } else if (lowerName.includes('ถุง') || lowerName.includes('ห่อ')) {
            stk.unit = 'ถุง';
          } else if (lowerName.includes('กระป๋อง') || lowerName.includes('กป')) {
            stk.unit = 'กระป๋อง';
          } else {
            stk.unit = 'ขวด';
          }
          if (Number(stk.unitCost) > 0) {
            stk.unitCost = parseFloat((Number(stk.unitCost) / crateBottles).toFixed(4));
          }
          if (stk.minQty > 0) {
            stk.minQty = Math.max(1, Math.round(stk.minQty * crateBottles));
          }
          if (!stk.rawUnit) stk.rawUnit = currentUnit;
          changed = true;
        }
      });
    }

    // Migration: แยกสินค้าที่เคยถูกรวมสต๊อกผิดพลาดเพราะชื่อต่างกันแค่วงเล็บ เช่น ดีโด้โยเกิร์ต(สตอ), ดีโด้โยเกิร์ต(ส้ม), ดีโด้โยเกิร์ต(เขียว)
    if (!parsed._splitParenVariants && Array.isArray(parsed.stockItems) && Array.isArray(parsed.expenses)) {
      const normName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
      const existingStockNames = new Set(parsed.stockItems.map(s => normName(s?.name)).filter(Boolean));
      parsed.stockItems.slice().forEach(stk => {
        if (!stk || !stk.id) return;
        const stkBase = String(stk.name || '').split('(')[0].trim().toLowerCase();
        const linkedExps = parsed.expenses.filter(e => {
          if (!e || !e.title) return false;
          if (String(e.stockItemId || '') === String(stk.id)) return true;
          const eNorm = normName(e.title);
          const eBase = String(e.title).split('(')[0].trim().toLowerCase();
          return !existingStockNames.has(eNorm) && stkBase && eBase === stkBase;
        });
        if (linkedExps.length <= 1) return;
        const groups = new Map();
        linkedExps.forEach(e => {
          const key = normName(e.title);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(e);
        });
        if (groups.size <= 1) return;
        const stkKey = normName(stk.name);
        groups.forEach((exps, key) => {
          if (key === stkKey) return;
          const sample = exps[0];
          let totalPieces = 0;
          exps.forEach(e => {
            const pSize = Number(e.packSize) || 1;
            const rawU = String(e.packUnit || '').trim();
            const isBulk = rawU.includes('ลัง') || rawU.includes('แพ็ค') || rawU.includes('กล่อง') ||
              rawU.toLowerCase() === 'crate' || rawU.toLowerCase() === 'pack' || rawU.toLowerCase() === 'box';
            const cb = (isBulk && Number(e.crateBottles) > 0) ? Number(e.crateBottles) : 1;
            totalPieces += pSize * cb;
          });
          stk.qty = Math.max(0, Math.round(((Number(stk.qty) || 0) - totalPieces) * 100) / 100);
          const newId = 'stk_' + Date.now() + Math.random().toString(36).substring(2, 5);
          const sampleSize = Number(sample.packSize) || 1;
          const sampleRawU = String(sample.packUnit || '').trim();
          const sampleBulk = sampleRawU.includes('ลัง') || sampleRawU.includes('แพ็ค') || sampleRawU.includes('กล่อง');
          const sampleCb = (sampleBulk && Number(sample.crateBottles) > 0) ? Number(sample.crateBottles) : 1;
          const samplePieces = sampleSize * sampleCb;
          const unitCost = samplePieces > 0 ? parseFloat((Number(sample.amount || 0) / samplePieces).toFixed(4)) : 0;
          const newItem = {
            ...stk,
            id: newId,
            name: sample.title,
            qty: totalPieces,
            unitCost: unitCost || stk.unitCost,
            supplier: sample.supplier || stk.supplier || '',
            category: sample.category || stk.category,
            netWeight: sample.netWeight || stk.netWeight || null,
            netUnit: sample.netUnit || stk.netUnit || null,
            minQty: (sample.minQty !== undefined && sample.minQty !== null && sample.minQty !== '') ? Number(sample.minQty) : stk.minQty
          };
          parsed.stockItems.unshift(newItem);
          exps.forEach(e => { e.stockItemId = newId; });
          existingStockNames.add(key);
          changed = true;
        });
      });
      parsed._splitParenVariants = true;
      changed = true;
    }

    // Migration: ปรับวันที่ของประวัติสต๊อกเดิมที่มาจากบิลซื้อ/เติมสต๊อก ให้ตรงกับวันที่บิลจริง
    if (!parsed._syncedStockLogBillDates && Array.isArray(parsed.stockLogs)) {
      const thaiMonths = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
      const parseThaiDateToISO = (str) => {
        const m = String(str || '').match(/(\d{1,2})\s+(ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s+(\d{4})/);
        if (!m) return null;
        const day = String(parseInt(m[1], 10)).padStart(2, '0');
        const mIdx = thaiMonths.indexOf(m[2]);
        if (mIdx === -1) return null;
        const month = String(mIdx + 1).padStart(2, '0');
        const yearBE = parseInt(m[3], 10);
        const yearAD = yearBE > 2400 ? yearBE - 543 : yearBE;
        return `${yearAD}-${month}-${day}`;
      };
      const expById = new Map((parsed.expenses || []).filter(e => e && e.id).map(e => [String(e.id), e]));
      parsed.stockLogs.forEach(log => {
        if (!log) return;
        let targetDate = null;
        if (log.expenseId && expById.has(String(log.expenseId))) {
          const exp = expById.get(String(log.expenseId));
          if (exp && exp.date) targetDate = String(exp.date).substring(0, 10);
        }
        if (!targetDate && log.note) {
          const billMatch = String(log.note).match(/(?:จากบิลซื้อ|จากการแก้ไขบิลซื้อ|ลบบิลซื้อ[^\(]*)\s*\(([^)]+)\)/);
          if (billMatch) {
            targetDate = parseThaiDateToISO(billMatch[1]);
          }
        }
        if (targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate) && log.date !== targetDate) {
          log.date = targetDate;
          changed = true;
        }
      });
      parsed._syncedStockLogBillDates = true;
      changed = true;
    }

    return changed;
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
        // If remote data exists, sync it and run migrations
        this.data = data.data;
        const migrated = this.migrateData(this.data);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
        if (migrated) {
          await this.pushDataToCloud(this.data);
        }
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
    this.renderDrinkSalesHistory();
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

  // ตรวจสอบว่าวันที่ระบุอยู่ในช่วงปิดเทอมหรือไม่
  isVacationDay(dateStr) {
    if (!this.data.shopSettings) return false;
    const periods = this.data.shopSettings.vacationPeriods || [];
    for (const p of periods) {
      if (p.start && p.end) {
        if (dateStr >= p.start && dateStr <= p.end) {
          return true;
        }
      }
    }
    return false;
  }

  // ดึงชื่อช่วงปิดเทอมของวันที่นั้นๆ (ถ้ามี)
  getVacationPeriodName(dateStr) {
    if (!this.data.shopSettings) return '';
    const periods = this.data.shopSettings.vacationPeriods || [];
    for (const p of periods) {
      if (p.start && p.end && dateStr >= p.start && dateStr <= p.end) {
        return p.name || 'ช่วงปิดเทอมโรงเรียน';
      }
    }
    return '';
  }

  // วันเปิดเรียนจริง = ไม่ใช่เสาร์-อาทิตย์, ไม่ใช่วันหยุดนักขัตฤกษ์ และไม่อยู่ในช่วงปิดเทอม
  isSchoolOpenDay(dateStr) {
    return !this.isWeekend(dateStr) && !this.isHoliday(dateStr) && !this.isVacationDay(dateStr);
  }

  // คำนวณวันเปิดเรียนจริงของเดือนนั้นอย่างแม่นยำ (หักเสาร์อาทิตย์ วันหยุด และช่วงปิดเทอมจริง)
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
    return openDays;
  }

  // ตรวจสอบว่าเดือนนี้เป็นเดือนปิดเทอมหรือไม่
  // หากมีวันปิดเทอมในเดือน หรือเปิดเรียนน้อยมาก (เช่น มีช่วงปิดเทอมกินเวลาส่วนใหญ่ของเดือน) ให้ถือเป็นเดือนปิดเทอม (ค่าเช่า ฿0)
  isVacationMonth(ymOrMonth) {
    if (!this.data.shopSettings) return false;
    let ym = '';
    if (typeof ymOrMonth === 'string' && ymOrMonth.includes('-')) {
      ym = ymOrMonth;
    } else {
      const nowY = new Date().getFullYear();
      const m = typeof ymOrMonth === 'number' ? ymOrMonth : parseInt(ymOrMonth, 10);
      ym = `${nowY}-${String(m).padStart(2, '0')}`;
    }

    const openDays = this.getSchoolOpenDaysCount(ym);
    if (openDays === 0) return true;

    // ตรวจสอบว่าเดือนนี้มีวันปิดเทอมหรือไม่
    const [yearStr, monthStr] = ym.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const daysInMonth = new Date(year, month, 0).getDate();
    let vacationDaysCount = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      const dStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (this.isVacationDay(dStr)) vacationDaysCount++;
    }

    // ถ้ามีวันปิดเทอมตั้งแต่ 10 วันขึ้นไป หรือเปิดเรียนจริงเหลือน้อยกว่า 5 วัน ให้ถือว่าเป็นเดือนปิดเทอม (ยกเว้นค่าเช่า)
    return vacationDaysCount >= 10 || (vacationDaysCount > 0 && openDays <= 5);
  }

  // คำนวณค่าเช่าของเดือนนั้น:
  // - ถ้าเป็นเดือนปิดเทอม หรือเปิดเรียน 0 วัน = ฿0 (ไม่คิดค่าเช่าเลย)
  // - ถ้าเปิดเรียนเต็มเดือนปกติ = ค่าเช่าเต็มเดือนปกติ
  getRentForMonth(ym) {
    if (this.isVacationMonth(ym)) {
      return 0; // เดือนปิดเทอม = ไม่คิดค่าเช่า (฿0)
    }
    const openDays = this.getSchoolOpenDaysCount(ym);
    if (openDays === 0) {
      return 0; // ไม่มีวันเปิดเรียน = ไม่คิดค่าเช่า (฿0)
    }
    const baseRent = (this.data.shopSettings && Number(this.data.shopSettings.monthlyRent)) || 10000;

    // ตรวจสอบวันทำงานปกติของเดือน (จ.-ศ. ไม่รวมวันหยุดนักขัตฤกษ์)
    const [yearStr, monthStr] = ym.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const daysInMonth = new Date(year, month, 0).getDate();
    let weekdaysCount = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      const dStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (!this.isWeekend(dStr) && !this.isHoliday(dStr)) weekdaysCount++;
    }

    // หากเดือนนี้มีช่วงปิดเทอม ให้คิดค่าเช่าตามสัดส่วนวันที่เปิดจริง
    if (weekdaysCount > 0 && openDays < weekdaysCount) {
      const proratedRent = Math.round((baseRent * openDays) / weekdaysCount);
      return Math.max(0, proratedRent);
    }

    return baseRent;
  }

  getDailyRentForSchoolDay(dateStr = null) {
    if (!dateStr) dateStr = this.formatDate(new Date());
    if (this.isVacationDay(dateStr)) {
      return 0; // วันที่อยู่ในช่วงปิดเทอม = ค่าเช่ารายวันเป็น 0
    }
    const ym = dateStr.substring(0, 7);
    const rent = this.getRentForMonth(ym);
    const days = this.getSchoolOpenDaysCount(ym);
    return days > 0 ? Math.round(rent / days) : 0;
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

  // จัดรูปแบบต้นทุนต่อหน่วย — ใช้ทศนิยมมากขึ้นสำหรับราคาเล็กมาก เพื่อไม่ให้สูญเสียความแม่นยำ
  formatUnitCost(cost) {
    const n = Number(cost) || 0;
    if (n === 0) return '0.00';
    if (Math.abs(n) < 0.1) return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.00');
    return n.toFixed(2);
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

    // Initialize vacation periods UI
    this.renderVacationPeriodsUI();
  }

  // วาดรายการช่วงเวลาปิดเทอม (กำหนดวัน-ปีชัดเจน)
  renderVacationPeriodsUI() {
    const container = document.getElementById('vacationPeriodsListContainer');
    const badge = document.getElementById('vacationPeriodsCountBadge');
    const periods = (this.data.shopSettings && this.data.shopSettings.vacationPeriods) || [];

    if (badge) {
      badge.textContent = `${periods.length} ช่วงเวลา`;
      badge.className = periods.length > 0 ? 'pill-tag purple-tag' : 'pill-tag';
    }

    if (!container) return;

    if (periods.length === 0) {
      container.innerHTML = `
        <div style="background:#ffffff; border:1px dashed #cbd5e1; border-radius:var(--radius-sm); padding:1rem; text-align:center; color:#94a3b8; font-size:0.8rem;">
          ยังไม่มีการกำหนดช่วงปิดเทอม (โรงเรียนเปิดเรียนปกติทุกเดือน)
        </div>
      `;
      this.refreshLucide();
      return;
    }

    container.innerHTML = periods.map(p => {
      const startThai = this.formatThaiDate(p.start);
      const endThai = this.formatThaiDate(p.end);

      // คำนวณจำนวนวันทั้งหมดในช่วงปิดเทอมนี้
      const d1 = new Date(p.start);
      const d2 = new Date(p.end);
      const diffDays = Math.max(1, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1);

      return `
        <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:var(--radius-sm); padding:0.65rem 0.85rem; display:flex; justify-content:space-between; align-items:center; gap:0.5rem; box-shadow:0 1px 3px rgba(0,0,0,0.03);">
          <div style="min-width:0;">
            <div style="font-weight:700; color:var(--text-main); font-size:0.85rem; display:flex; align-items:center; gap:0.35rem;">
              <span class="pill-tag purple-tag" style="font-size:0.7rem; padding:1px 6px;">🏖️ ปิดเทอม</span>
              <span>${this.escapeHtml(p.name || 'ช่วงปิดเทอม')}</span>
            </div>
            <div style="font-size:0.75rem; color:#64748b; margin-top:2px;">
              <span>📅 ${startThai} ถึง ${endThai}</span>
              <span style="color:#8b5cf6; font-weight:600; margin-left:4px;">(หยุดรวม ${diffDays} วัน)</span>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:0.35rem; flex-shrink:0;">
            <button type="button" class="icon-btn-border" onclick="app.editVacationPeriod('${p.id}')" title="แก้ไขช่วงเวลานี้" style="padding:0.25rem 0.45rem; cursor:pointer;">
              <i data-lucide="edit-3" style="width:13px; height:13px; color:var(--primary);"></i>
            </button>
            <button type="button" class="icon-btn-border" onclick="app.removeVacationPeriod('${p.id}')" title="ลบช่วงเวลานี้" style="padding:0.25rem 0.45rem; cursor:pointer;">
              <i data-lucide="trash-2" style="width:13px; height:13px; color:var(--danger);"></i>
            </button>
          </div>
        </div>
      `;
    }).join('');

    this.refreshLucide();
  }

  // เริ่มต้นแก้ไขช่วงปิดเทอม
  editVacationPeriod(periodId) {
    if (!this.data.shopSettings || !Array.isArray(this.data.shopSettings.vacationPeriods)) return;
    const period = this.data.shopSettings.vacationPeriods.find(p => p.id === periodId);
    if (!period) return;

    const editIdInput = document.getElementById('editVacationId');
    const nameInput = document.getElementById('newVacationName');
    const startInput = document.getElementById('newVacationStart');
    const endInput = document.getElementById('newVacationEnd');
    const formTitle = document.getElementById('vacationFormTitle');
    const btnText = document.getElementById('btnAddVacationText');
    const btnCancel = document.getElementById('btnCancelEditVacation');
    const formBox = document.getElementById('vacationFormBox');

    if (editIdInput) editIdInput.value = period.id;
    if (nameInput) nameInput.value = period.name || '';
    if (startInput) startInput.value = period.start || '';
    if (endInput) endInput.value = period.end || '';
    if (formTitle) formTitle.textContent = `แก้ไขช่วงปิดเทอม: ${period.name || ''}`;
    if (btnText) btnText.textContent = 'บันทึกแก้ไข';
    if (btnCancel) btnCancel.style.display = 'inline-block';
    if (formBox) {
      formBox.style.borderColor = 'var(--primary)';
      formBox.style.boxShadow = '0 0 0 2px rgba(99, 102, 241, 0.15)';
      formBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ยกเลิกโหมดแก้ไข
  cancelEditVacation() {
    const editIdInput = document.getElementById('editVacationId');
    const nameInput = document.getElementById('newVacationName');
    const startInput = document.getElementById('newVacationStart');
    const endInput = document.getElementById('newVacationEnd');
    const formTitle = document.getElementById('vacationFormTitle');
    const btnText = document.getElementById('btnAddVacationText');
    const btnCancel = document.getElementById('btnCancelEditVacation');
    const formBox = document.getElementById('vacationFormBox');

    if (editIdInput) editIdInput.value = '';
    if (nameInput) nameInput.value = '';
    if (startInput) startInput.value = '';
    if (endInput) endInput.value = '';
    if (formTitle) formTitle.textContent = 'เพิ่มช่วงเวลาปิดเทอมใหม่:';
    if (btnText) btnText.textContent = 'เพิ่ม';
    if (btnCancel) btnCancel.style.display = 'none';
    if (formBox) {
      formBox.style.borderColor = '#cbd5e1';
      formBox.style.boxShadow = 'none';
    }
  }

  // เพิ่มหรือบันทึกแก้ไขช่วงปิดเทอม
  addVacationPeriod() {
    const editIdInput = document.getElementById('editVacationId');
    const nameInput = document.getElementById('newVacationName');
    const startInput = document.getElementById('newVacationStart');
    const endInput = document.getElementById('newVacationEnd');

    const editId = editIdInput?.value.trim();
    const name = nameInput?.value.trim() || 'ปิดเทอม';
    const start = startInput?.value;
    const end = endInput?.value;

    if (!start || !end) {
      this.showToast('กรุณาระบุทั้งวันที่เริ่มและวันที่สิ้นสุดการปิดเทอม', 'error');
      return;
    }

    if (start > end) {
      this.showToast('วันที่เริ่มต้องอยู่ก่อนวันสิ้นสุด', 'error');
      return;
    }

    if (!this.data.shopSettings) this.data.shopSettings = {};
    if (!Array.isArray(this.data.shopSettings.vacationPeriods)) {
      this.data.shopSettings.vacationPeriods = [];
    }

    if (editId) {
      // โหมดแก้ไข
      const index = this.data.shopSettings.vacationPeriods.findIndex(p => p.id === editId);
      if (index !== -1) {
        this.data.shopSettings.vacationPeriods[index] = {
          ...this.data.shopSettings.vacationPeriods[index],
          name,
          start,
          end
        };
      }
      this.showToast(`แก้ไขข้อมูล "${name}" เรียบร้อยแล้ว`, 'success');
    } else {
      // โหมดเพิ่มใหม่
      const newPeriod = {
        id: 'vp_' + Date.now(),
        name,
        start,
        end
      };
      this.data.shopSettings.vacationPeriods.push(newPeriod);
      this.showToast(`เพิ่ม "${name}" (${this.formatThaiDate(start)} - ${this.formatThaiDate(end)}) เรียบร้อยแล้ว`, 'success');
    }

    // เรียงตามวันที่เริ่ม
    this.data.shopSettings.vacationPeriods.sort((a, b) => a.start.localeCompare(b.start));

    this.saveData();
    this.cancelEditVacation();
    this.renderVacationPeriodsUI();
    this.renderDashboard();
    this.renderCalendar(); // อัปเดตปฏิทินทันที
    const todayDate = document.getElementById('dailyFormDate')?.value || this.formatDate(new Date());
    this.loadDailyFormForDate(todayDate);
    this.renderTodaySummary(todayDate);
  }

  // ลบช่วงปิดเทอม
  removeVacationPeriod(periodId) {
    if (!this.data.shopSettings || !Array.isArray(this.data.shopSettings.vacationPeriods)) return;
    const period = this.data.shopSettings.vacationPeriods.find(p => p.id === periodId);
    const pName = period ? period.name : 'ช่วงปิดเทอม';

    if (confirm(`คุณต้องการลบ "${pName}" ออกใช่หรือไม่?`)) {
      this.data.shopSettings.vacationPeriods = this.data.shopSettings.vacationPeriods.filter(p => p.id !== periodId);

      // ถ้ายกเลิกตัวที่กำลังแก้ไขอยู่ ให้รีเซ็ตฟอร์ม
      const editIdInput = document.getElementById('editVacationId');
      if (editIdInput && editIdInput.value === periodId) {
        this.cancelEditVacation();
      }

      this.saveData();
      this.renderVacationPeriodsUI();
      this.renderDashboard();
      this.renderCalendar(); // อัปเดตปฏิทินทันที
      const todayDate = document.getElementById('dailyFormDate')?.value || this.formatDate(new Date());
      this.loadDailyFormForDate(todayDate);
      this.renderTodaySummary(todayDate);
      this.showToast(`ลบ "${pName}" แล้ว`, 'info');
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
    document.querySelectorAll('#expensePillFilterGroup .figma-pill-filter').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const cat = e.currentTarget.dataset.cat;
        if (cat) {
          this.setExpenseCategory(cat);
        }
      });
    });

    // Expense Realtime Search Input (ชื่อ, หมวด, แหล่งซื้อ, หมายเหตุ)
    const expSearchInput = document.getElementById('expenseSearchInput');
    const expSearchClear = document.getElementById('expenseSearchClearBtn');
    if (expSearchInput) {
      expSearchInput.addEventListener('input', (e) => {
        const q = e.target.value.trim();
        if (expSearchClear) {
          expSearchClear.style.display = q ? 'block' : 'none';
        }
        this.renderExpenses();
      });
    }
    if (expSearchClear) {
      expSearchClear.addEventListener('click', () => {
        if (expSearchInput) {
          expSearchInput.value = '';
          expSearchClear.style.display = 'none';
          expSearchInput.focus();
        }
        this.renderExpenses();
      });
    }

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

    // Stock Filter Tabs & Search (Optimized for Mobile, iPad, and Desktop)
    const stockFilterTabs = document.getElementById('stockFilterTabs');
    if (stockFilterTabs) {
      stockFilterTabs.addEventListener('click', (e) => {
        const label = e.target.closest('.radio-tab');
        if (!label) return;
        const radio = label.querySelector('input[name="stockSubFilter"]');
        if (radio) {
          radio.checked = true;
          this.setStockFilter(radio.value);
        }
      });
    }

    document.querySelectorAll('input[name="stockSubFilter"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.setStockFilter(e.target.value);
      });
    });

    const stockSearch = document.getElementById('stockSearchInput');
    if (stockSearch) {
      ['input', 'change', 'search'].forEach(evt => {
        stockSearch.addEventListener(evt, () => {
          this.applyStockFilter();
        });
      });
    }

    // Helper to toggle sort buttons
    const bindSortToggle = (btnId, onToggle) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        const current = btn.dataset.order || 'newest';
        const next = current === 'newest' ? 'oldest' : 'newest';
        btn.dataset.order = next;
        const textSpan = btn.querySelector('.sort-text');
        if (textSpan) {
          textSpan.textContent = next === 'newest' ? 'ล่าสุด' : 'เก่าสุด';
        }
        if (typeof onToggle === 'function') onToggle(next);
      });
    };

    // Sort order change listeners for Sales, Expenses, Recipes, and Stock (Toggle Buttons)
    bindSortToggle('dailySalesSortOrder', () => this.renderDailyHistoryTable());
    bindSortToggle('expenseSortOrder', () => this.renderExpenses());
    bindSortToggle('recipeSortOrder', () => this.renderRecipes());
    bindSortToggle('stockSortOrder', () => this.renderStock());

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
          if (backdrop.id === 'recipeModal' || backdrop.id === 'expenseModal' || backdrop.id === 'stockItemModal' || backdrop.id === 'quickRestockModal' || backdrop.id === 'packSellPickerModal') {
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

        this.data.shopSettings.name = name;
        this.data.shopSettings.monthlyRent = rent;

        this.saveData();
        this.updateShopBranding();
        this.renderVacationPeriodsUI();
        this.showToast(`บันทึกการตั้งค่าร้านค้าเรียบร้อยแล้ว`, 'success');
        this.renderDashboard();
        const todayDate = document.getElementById('dailyFormDate')?.value || this.formatDate(new Date());
        this.loadDailyFormForDate(todayDate);
        this.renderTodaySummary(todayDate);
      });
    }

    // Vacation Periods Add/Save & Cancel Edit Buttons
    const btnAddVac = document.getElementById('btnAddVacationPeriod');
    if (btnAddVac) {
      btnAddVac.addEventListener('click', () => this.addVacationPeriod());
    }
    const btnCancelVac = document.getElementById('btnCancelEditVacation');
    if (btnCancelVac) {
      btnCancelVac.addEventListener('click', () => this.cancelEditVacation());
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

    // Reset All Data Modal & Actions
    const btnOpenResetAll = document.getElementById('btnOpenResetAllModal');
    if (btnOpenResetAll) {
      btnOpenResetAll.addEventListener('click', () => {
        this.openResetAllModal();
      });
    }

    const inputConfirmDelete = document.getElementById('inputConfirmDeleteAll');
    const btnConfirmDelete = document.getElementById('btnConfirmDeleteAll');
    if (inputConfirmDelete && btnConfirmDelete) {
      inputConfirmDelete.addEventListener('input', (e) => {
        const val = (e.target.value || '').trim().toUpperCase();
        const isValid = val === 'DELETE' || val === 'ลบ';
        btnConfirmDelete.disabled = !isValid;
      });

      inputConfirmDelete.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !btnConfirmDelete.disabled) {
          this.resetAllData();
        }
      });

      btnConfirmDelete.addEventListener('click', () => {
        this.resetAllData();
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

  openResetAllModal() {
    const modal = document.getElementById('resetAllDataModal');
    if (!modal) return;

    const countSales = document.getElementById('resetCountSales');
    const countExpenses = document.getElementById('resetCountExpenses');
    const countStock = document.getElementById('resetCountStock');
    const countRecipes = document.getElementById('resetCountRecipes');
    const countProducts = document.getElementById('resetCountProducts');

    if (countSales) countSales.textContent = (this.data.dailySales || []).length;
    if (countExpenses) countExpenses.textContent = (this.data.expenses || []).length;
    if (countStock) countStock.textContent = (this.data.stockItems || []).length;
    if (countRecipes) countRecipes.textContent = (this.data.recipes || []).length;
    if (countProducts) countProducts.textContent = (this.data.savedProducts || []).length;

    const input = document.getElementById('inputConfirmDeleteAll');
    const btn = document.getElementById('btnConfirmDeleteAll');
    if (input) input.value = '';
    if (btn) btn.disabled = true;

    modal.classList.add('active');
    this.refreshLucide();
    if (input) setTimeout(() => input.focus(), 100);
  }

  closeResetAllModal() {
    const modal = document.getElementById('resetAllDataModal');
    if (modal) modal.classList.remove('active');
  }

  resetAllData() {
    this.data = JSON.parse(JSON.stringify(DEFAULT_DATA));
    this.saveData(this.data, true);
    this.closeResetAllModal();
    this.initViews();
    this.showToast('ลบข้อมูลทั้งหมดเรียบร้อยแล้ว คืนค่าระบบกลับเป็นค่าเริ่มต้น', 'success');
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
    this.populatePackSellDropdowns();
    this.initPackSell();

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
      this.currentStockFilter = 'all';
      const radioAll = document.querySelector('input[name="stockSubFilter"][value="all"]');
      if (radioAll) radioAll.checked = true;
      this.renderStock();
    } else if (cleanTabId === 'pack-sell') {
      this.populatePackSellDropdowns();
    } else if (cleanTabId === 'drink-sales') {
      this.initDrinkSales();
      this.calculateDrinkSalesCups();
      this.renderDrinkSalesHistory();
    } else if (cleanTabId === 'stock-history') {
      this.renderStockHistory();
    } else if (cleanTabId === 'expenses') {
      this.renderExpenses();
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

    // แยกค่าใช้จ่ายตามหมวด
    const catIngredient = filteredExpenses.filter(e => e.category === 'INGREDIENT').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catPackaging = filteredExpenses.filter(e => e.category === 'PACKAGING').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catStock = filteredExpenses.filter(e => e.category === 'STOCK').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catFridgeDrink = filteredExpenses.filter(e => e.category === 'FRIDGE_DRINK').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catOther = filteredExpenses.filter(e => e.category === 'OTHER').reduce((a, b) => a + (Number(b.amount) || 0), 0);

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

    // Rent Progress Bar in Dashboard & Sidebar
    const rentProgressPercent = totalRentForPeriod > 0 ? Math.min(100, Math.max(0, (grossProfitBeforeRent / totalRentForPeriod) * 100)) : 100;
    const progressBar = document.getElementById('rentProgressBar');
    const progressText = document.getElementById('rentProgressText');
    const rentCoverageCard = document.getElementById('dashRentCoverageCard');

    if (progressBar) {
      if (totalRentForPeriod === 0) {
        progressBar.style.width = '100%';
        progressBar.style.background = 'linear-gradient(90deg, #8b5cf6 0%, #10b981 100%)';
      } else {
        progressBar.style.width = `${rentProgressPercent.toFixed(0)}%`;
        progressBar.style.background = 'linear-gradient(90deg, #8b5cf6 0%, #10b981 100%)';
      }
    }
    if (progressText) {
      if (totalRentForPeriod === 0) {
        progressText.textContent = `🏖️ ปิดเทอม (ไม่คิดค่าเช่าร้าน ฿0)`;
        progressText.style.color = '#7e22ce';
      } else if (grossProfitBeforeRent >= totalRentForPeriod) {
        progressText.textContent = `กำไรครอบคลุมค่าเช่าร้านแล้ว! (${rentProgressPercent.toFixed(0)}%)`;
        progressText.style.color = '#047857';
      } else {
        progressText.textContent = `กำไรเบื้องต้น ฿${grossProfitBeforeRent.toLocaleString()} / ฿${totalRentForPeriod.toLocaleString()} (${rentProgressPercent.toFixed(0)}%)`;
        progressText.style.color = '#7e22ce';
      }
    }

    // Sidebar Footer Rent Card Update
    const sidebarRentAmount = document.querySelector('.rent-reminder-card .rent-amount');
    const sidebarRentFill = document.getElementById('rentProgressBarSidebar');
    const sidebarRentCaption = document.querySelector('.rent-reminder-card .rent-caption');
    if (sidebarRentAmount) {
      if (totalRentForPeriod === 0) {
        sidebarRentAmount.textContent = '฿0 / ปิดเทอม';
        sidebarRentAmount.style.color = '#8b5cf6';
      } else {
        sidebarRentAmount.textContent = `${this.formatCurrency(totalRentForPeriod)} / เดือน`;
        sidebarRentAmount.style.color = '';
      }
    }
    if (sidebarRentFill) {
      sidebarRentFill.style.width = `${rentProgressPercent.toFixed(0)}%`;
    }
    if (sidebarRentCaption) {
      if (totalRentForPeriod === 0) {
        sidebarRentCaption.textContent = '🏖️ ปิดเทอม ยกเว้นค่าเช่า';
      } else {
        sidebarRentCaption.textContent = 'เป้าหมายยอดกำไรคุ้มค่าเช่า';
      }
    }

    // Recent Daily Sales Table in Dashboard
    this.renderDashboardRecentSales(filteredDailySales);

    // Performance Stats in Dashboard
    this.renderDashboardPerformance(filteredDailySales, totalRevenue, netProfit);

    // Charts
    this.renderDashboardCharts(filteredDailySales, totalRevenue, materialCost, totalRentForPeriod, netProfit, period, { catIngredient, catPackaging, catStock, catFridgeDrink, catOther });
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
          const isVacation = this.isVacationDay(d.date);
          const isHol = this.isPublicHoliday(d.date) || !!this.getCustomHoliday(d.date);
          const isWk = this.isWeekend(d.date);
          const isOpen = this.isSchoolOpenDay(d.date);

          let pillText = 'วันเปิดเรียน';
          let pillClass = 'open';
          if (isVacation) {
            pillText = '🏖️ ปิดเทอม';
            pillClass = 'holiday';
          } else if (isHol) {
            pillText = 'วันหยุด';
            pillClass = 'holiday';
          } else if (isWk) {
            pillText = 'ส-อา';
            pillClass = 'holiday';
          }

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
                      <span class="figma-tx-pill ${pillClass}">
                        ${pillText}
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

    // Render Top 5 Most Used Stock Items (เฉพาะน้ำขายในตู้ FRIDGE_DRINK)
    const topStockListElem = document.getElementById('dashTopStockItemsList');
    if (topStockListElem) {
      const logs = this.data.stockLogs || [];
      const stockItems = this.data.stockItems || [];
      const usageMap = {};

      // Helper to check if item is a fridge drink (น้ำขายในตู้)
      const isFridgeDrink = (name) => {
        const lower = (name || '').toLowerCase();
        const found = stockItems.find(s => s.name && s.name.toLowerCase() === lower);
        if (found && found.category === 'FRIDGE_DRINK') return true;
        return lower.includes('น้ำ') || lower.includes('นม') || lower.includes('ชา') || lower.includes('กาแฟ') ||
          lower.includes('โค้ก') || lower.includes('แฟนต้า') || lower.includes('สไปรท์') || lower.includes('เครื่องดื่ม') ||
          lower.includes('ลัง') || lower.includes('ขวด') || lower.includes('ยกลัง') || lower.includes('สำเร็จรูป');
      };

      // Tally from actual logs
      logs.forEach(log => {
        if (log.actionType === 'USE' && log.changeQty < 0 && isFridgeDrink(log.itemName)) {
          const name = log.itemName;
          const qty = Math.abs(log.changeQty);
          if (!usageMap[name]) {
            usageMap[name] = { name: name, qty: 0, unit: log.unit || 'ขวด', revenue: 0, profit: 0 };
          }
          usageMap[name].qty += qty;

          // ดึงยอดขายและกำไรจาก log
          const parsed = this.parseProfitInfoFromLog(log);
          if (parsed) {
            usageMap[name].revenue += parsed.revenue || 0;
            usageMap[name].profit += parsed.profit || 0;
          }
        }
      });

      let topItems = Object.values(usageMap).sort((a, b) => b.qty - a.qty);

      if (topItems.length === 0) {
        topStockListElem.innerHTML = `
          <div class="text-center text-muted py-3" style="font-size:0.8rem; background:#f8fafc; border:1px dashed var(--border-color); border-radius:var(--radius-sm);">
            ยังไม่มีประวัติการเบิกขายน้ำในตู้
          </div>
        `;
        return;
      }

      const top5 = topItems.slice(0, 5);

      topStockListElem.innerHTML = top5.map((item, idx) => {
        const rankBadge = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][idx] || `#${idx + 1}`;
        const isProfit = item.profit >= 0;
        const profitSign = isProfit ? '+' : '';

        return `
          <div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:0.5rem 0.65rem; font-size:0.825rem;">
            <div style="display:flex; align-items:center; gap:0.45rem; overflow:hidden; flex:1; min-width:0;">
              <span style="font-size:0.95rem; flex-shrink:0;">${rankBadge}</span>
              <div style="overflow:hidden;">
                <div class="font-bold text-main" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(item.name)}</div>
                <div style="display:flex; gap:0.5rem; font-size:0.72rem; color:#64748b; margin-top:1px;">
                  <span>ขาย ${this.formatCurrency(item.revenue)}</span>
                  <span style="color:${isProfit ? '#16a34a' : '#dc2626'}; font-weight:700;">${profitSign}${this.formatCurrency(item.profit)}</span>
                </div>
              </div>
            </div>
            <div style="text-align:right; flex-shrink:0; margin-left:0.5rem;">
              <b class="text-primary">${item.qty}</b> <span class="text-xs text-muted">${this.escapeHtml(item.unit)}</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  renderDashboardCharts(filteredDailySales = null, totalRevenue = 0, totalCost = 0, totalRent = 10000, netProfit = 0, period = null, catBreakdown = {}) {
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

    // 2. Horizontal Percentage Breakdown Bars (แทน Doughnut Chart)
    const breakdownWrap = document.getElementById('costBreakdownChart');
    if (breakdownWrap) {
      // ทำลาย Chart.js canvas เดิม (ถ้ามี) แล้วใช้ HTML แทน
      if (this.charts.breakdown) {
        this.charts.breakdown.destroy();
        this.charts.breakdown = null;
      }

      const safeProfit = Math.max(0, netProfit);
      const { catIngredient = 0, catPackaging = 0, catStock = 0, catFridgeDrink = 0, catOther = 0 } = catBreakdown;

      // รายการสัดส่วนค่าใช้จ่าย & กำไร (ไม่นำขาดทุนมารวมเป็นค่าใช้จ่าย)
      const items = [
        { label: '🧪 วัตถุดิบ', value: catIngredient, color: '#f59e0b', bg: '#fffbeb' },
        { label: '📦 บรรจุภัณฑ์', value: catPackaging, color: '#3b82f6', bg: '#eff6ff' },
        { label: '🧃 ยกลัง', value: catStock, color: '#8b5cf6', bg: '#f5f3ff' },
        { label: '🧊 น้ำในตู้', value: catFridgeDrink, color: '#06b6d4', bg: '#ecfeff' },
        { label: '🛠️ ค่าใช้จ่ายอื่นๆ', value: catOther, color: '#ec4899', bg: '#fdf2f8' },
        { label: '🏠 ค่าเช่าร้าน', value: totalRent, color: '#a855f7', bg: '#faf5ff' },
        { label: '💰 กำไรสุทธิ', value: safeProfit, color: '#10b981', bg: '#ecfdf5' }
      ];

      // ฐานคิดเปอร์เซ็นต์: หากมียอดขายให้คิดสัดส่วนเทียบกับยอดขาย (หรือยอดรวมรายการถ้าไม่มี/มากกว่ายอดขาย)
      const totalAllocated = items.reduce((s, i) => s + i.value, 0);
      const grandTotal = Math.max(totalRevenue, totalAllocated);

      // Replace canvas with a div container
      const parentEl = breakdownWrap.parentElement;
      let barContainer = document.getElementById('costBreakdownBars');
      if (!barContainer) {
        barContainer = document.createElement('div');
        barContainer.id = 'costBreakdownBars';
        parentEl.replaceChild(barContainer, breakdownWrap);
      }
      barContainer.style.cssText = 'padding:0.25rem 0;';

      // Stacked bar at top
      const stackedItems = items.filter(i => i.value > 0);
      const stackedBarHtml = stackedItems.length > 0 ? `
        <div style="display:flex; height:28px; border-radius:6px; overflow:hidden; margin-bottom:0.75rem; box-shadow:inset 0 1px 3px rgba(0,0,0,0.08);">
          ${stackedItems.map(item => {
        const pct = grandTotal > 0 ? (item.value / grandTotal * 100) : 0;
        return `<div style="width:${pct}%; background:${item.color}; min-width:${pct > 2 ? '0' : '3px'}; transition:width 0.3s;" title="${item.label} ${pct.toFixed(1)}%"></div>`;
      }).join('')}
        </div>
      ` : '';

      barContainer.innerHTML = stackedBarHtml + items.map(item => {
        const pct = grandTotal > 0 ? (item.value / grandTotal * 100) : 0;
        if (item.value === 0 && pct === 0) return '';
        return `
          <div style="margin-bottom:0.5rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
              <span style="font-size:0.8rem; font-weight:600; color:#334155;">${item.label}</span>
              <div style="display:flex; align-items:center; gap:0.5rem;">
                <span style="font-size:0.8rem; font-weight:700; color:${item.color};">${this.formatCurrency(item.value)}</span>
                <span style="font-size:0.72rem; font-weight:700; color:#64748b; background:#f1f5f9; padding:1px 6px; border-radius:4px;">${pct.toFixed(1)}%</span>
              </div>
            </div>
            <div style="height:10px; background:#f1f5f9; border-radius:5px; overflow:hidden;">
              <div style="height:100%; width:${pct}%; background:${item.color}; border-radius:5px; transition:width 0.4s ease;"></div>
            </div>
          </div>
        `;
      }).join('');
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

    if (this.isVacationDay(dateStr)) {
      dailyRent = 0;
      const vName = this.getVacationPeriodName(dateStr) || 'ช่วงปิดเทอม';
      rentLabel = `🏖️ ${vName} (ยกเว้นไม่คิดค่าเช่าร้าน ฿0)`;
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
    const costBreakdownEl = document.getElementById('previewDailyCostBreakdown');

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
      if (costBreakdownEl) {
        costBreakdownEl.style.display = 'none';
        costBreakdownEl.innerHTML = '';
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

      // แสดงรายละเอียดแจกแจงค่าใช้จ่ายที่ทำให้ขาดทุน
      if (costBreakdownEl) {
        const matCostVal = costInfo.materialCost || 0;
        const rentVal = costInfo.dailyRent || 0;
        let details = [];
        if (rentVal > 0) {
          details.push(`<span>• <strong>ค่าเช่าร้าน:</strong> ฿${rentVal.toLocaleString()}</span>`);
        }
        if (matCostVal > 0) {
          details.push(`<span>• <strong>ต้นทุน & วัตถุดิบ:</strong> ฿${matCostVal.toLocaleString()}</span>`);
        }
        if (details.length === 0 && cost > 0) {
          details.push(`<span>• <strong>ต้นทุนรวมระบบ:</strong> ฿${cost.toLocaleString()}</span>`);
        }
        costBreakdownEl.innerHTML = `
          <div style="font-weight:700; margin-bottom:0.15rem; display:flex; align-items:center; gap:0.3rem;">
            <span>⚠️ รายละเอียดต้นทุนวันนี้ (รวม ฿${cost.toLocaleString()}):</span>
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:0.6rem 1rem;">
            ${details.join('')}
          </div>
        `;
        costBreakdownEl.style.display = 'block';
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
      if (this.isVacationDay(selectedDate)) {
        const vName = this.getVacationPeriodName(selectedDate) || 'ปิดเทอม';
        hubStatusTag.textContent = `🏖️ ${vName}`;
        hubStatusTag.className = 'figma-capsule-tag holiday';
      } else if (isSchoolOpen) {
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
      if (this.isVacationDay(selectedDate)) {
        const vName = this.getVacationPeriodName(selectedDate) || 'ช่วงปิดเทอม';
        subtitle.textContent = `ยอดขายประจำวัน ${this.formatThaiDate(selectedDate)} (${vName}) ยกเว้นไม่คิดค่าเช่าร้านประจำวัน (฿0)`;
      } else if (isSchoolOpen) {
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
    const summaryWrap = document.getElementById('salesHistorySummary');

    const sortEl = document.getElementById('dailySalesSortOrder');
    const sortOrder = sortEl?.dataset?.order || sortEl?.value || 'newest';

    // Search & Filter
    const searchQuery = (document.getElementById('salesHistorySearch')?.value || '').toLowerCase().trim();
    const filterVal = document.getElementById('salesHistoryFilter')?.value || 'ALL';

    let list = [...this.data.dailySales];

    // Apply filter
    if (filterVal === 'PROFIT') {
      list = list.filter(d => d.profit >= 0);
    } else if (filterVal === 'LOSS') {
      list = list.filter(d => d.profit < 0);
    } else if (filterVal === 'SCHOOL') {
      list = list.filter(d => this.isSchoolOpenDay(d.date));
    } else if (filterVal === 'HOLIDAY') {
      list = list.filter(d => !this.isSchoolOpenDay(d.date));
    }

    // Apply search
    if (searchQuery) {
      list = list.filter(d => {
        const thaiDate = this.formatThaiDate(d.date).toLowerCase();
        const dateRaw = (d.date || '').toLowerCase();
        const note = (d.note || '').toLowerCase();
        const revenue = String(d.revenue || 0);
        const profit = String(d.profit || 0);
        const cost = String(d.cost || 0);
        return thaiDate.includes(searchQuery) || dateRaw.includes(searchQuery) ||
          note.includes(searchQuery) || revenue.includes(searchQuery) ||
          profit.includes(searchQuery) || cost.includes(searchQuery);
      });
    }

    // Sort
    list.sort((a, b) => {
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

    // Render Summary Stats
    if (summaryWrap) {
      const totalRevenue = list.reduce((s, d) => s + (Number(d.revenue) || 0), 0);
      const totalCost = list.reduce((s, d) => s + (Number(d.cost) || 0), 0);
      const totalProfit = list.reduce((s, d) => s + (Number(d.profit) || 0), 0);
      const profitDays = list.filter(d => d.profit >= 0).length;
      const lossDays = list.filter(d => d.profit < 0).length;
      const avgProfit = list.length > 0 ? totalProfit / list.length : 0;
      const isNetProfit = totalProfit >= 0;

      summaryWrap.innerHTML = `
        <div style="background:#f0fdf4; border-radius:var(--radius-sm); padding:0.5rem 0.75rem; text-align:center; border:1px solid #bbf7d0;">
          <div style="font-size:0.7rem; color:#16a34a; font-weight:600;">💰 ยอดขายรวม</div>
          <div style="font-size:1rem; font-weight:800; color:#15803d;">${this.formatCurrency(totalRevenue)}</div>
        </div>
        <div style="background:#fef2f2; border-radius:var(--radius-sm); padding:0.5rem 0.75rem; text-align:center; border:1px solid #fecaca;">
          <div style="font-size:0.7rem; color:#dc2626; font-weight:600;">📉 ต้นทุนรวม</div>
          <div style="font-size:1rem; font-weight:800; color:#b91c1c;">${this.formatCurrency(totalCost)}</div>
        </div>
        <div style="background:${isNetProfit ? '#f0fdf4' : '#fef2f2'}; border-radius:var(--radius-sm); padding:0.5rem 0.75rem; text-align:center; border:1px solid ${isNetProfit ? '#bbf7d0' : '#fecaca'};">
          <div style="font-size:0.7rem; color:${isNetProfit ? '#16a34a' : '#dc2626'}; font-weight:600;">📊 กำไรสุทธิรวม</div>
          <div style="font-size:1rem; font-weight:800; color:${isNetProfit ? '#15803d' : '#b91c1c'};">${isNetProfit ? '+' : ''}${this.formatCurrency(totalProfit)}</div>
        </div>
        <div style="background:#eff6ff; border-radius:var(--radius-sm); padding:0.5rem 0.75rem; text-align:center; border:1px solid #bfdbfe;">
          <div style="font-size:0.7rem; color:#2563eb; font-weight:600;">📈 กำไรเฉลี่ย/วัน</div>
          <div style="font-size:1rem; font-weight:800; color:#1d4ed8;">${avgProfit >= 0 ? '+' : ''}${this.formatCurrency(avgProfit)}</div>
        </div>
        <div style="background:#f0fdf4; border-radius:var(--radius-sm); padding:0.5rem 0.75rem; text-align:center; border:1px solid #bbf7d0;">
          <div style="font-size:0.7rem; color:#16a34a; font-weight:600;">🟢 วันกำไร</div>
          <div style="font-size:1rem; font-weight:800; color:#15803d;">${profitDays} วัน</div>
        </div>
        <div style="background:#fef2f2; border-radius:var(--radius-sm); padding:0.5rem 0.75rem; text-align:center; border:1px solid #fecaca;">
          <div style="font-size:0.7rem; color:#dc2626; font-weight:600;">🔴 วันขาดทุน</div>
          <div style="font-size:1rem; font-weight:800; color:#b91c1c;">${lossDays} วัน</div>
        </div>
      `;
    }

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
        const rentVal = d.dailyRent !== undefined ? d.dailyRent : (isSchoolOpen ? this.getDailyRentForSchoolDay(d.date) : 0);
        const matVal = d.materialCost !== undefined ? d.materialCost : Math.max(0, (Number(d.cost) || 0) - rentVal);

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
                    ${!isProfit && (rentVal > 0 || matVal > 0) ? `
                      <span style="font-size:0.7rem; color:#dc2626; margin-left:0.25rem;">
                        (${rentVal > 0 ? `ค่าเช่า ฿${rentVal.toLocaleString()}` : ''}${rentVal > 0 && matVal > 0 ? ' + ' : ''}${matVal > 0 ? `วัตถุดิบ ฿${matVal.toLocaleString()}` : ''})
                      </span>
                    ` : ''}
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
            ${d.note ? this.formatDailySalesNote(d.note, d.id || d.date) : ''}

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

  // จัดรูปแบบหมายเหตุรายการขายในหน้าประวัติยอดขาย (แปลงรายการยาวๆ เป็นการ์ดย่อย + ปุ่มดูทั้งหมด/ย่อ)
  formatDailySalesNote(noteStr, cardKey) {
    if (!noteStr) return '';
    const raw = String(noteStr).trim();
    if (!raw) return '';

    // Split by ", " outside square brackets [...]
    const parts = [];
    let current = '';
    let bracketDepth = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '[') bracketDepth++;
      else if (ch === ']' && bracketDepth > 0) bracketDepth--;
      if (bracketDepth === 0 && ch === ',' && raw[i + 1] === ' ') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++; // skip space
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current.trim());

    // Check if this is a structured list of sale items
    const parsedItems = parts.map(part => {
      // Drink sale: 💰 ขายน้ำชง 42 แก้ว [สูตร...] (กำไร +฿252.06)
      const drinkMatch = part.match(/^💰\s*ขายน้ำชง\s+(\d+)\s*แก้ว\s*(?:\[([^\]]+)\])?\s*\(กำไร\s*([+\-]?฿[\d,]+(?:\.\d+)?)\)$/);
      if (drinkMatch) {
        return {
          type: 'drink',
          name: `น้ำชง ${drinkMatch[1]} แก้ว`,
          sub: drinkMatch[2] || '',
          qty: `${drinkMatch[1]} แก้ว`,
          profit: drinkMatch[3],
          isLoss: drinkMatch[3].startsWith('-')
        };
      }
      // Stock/product sale: ขาย <name> x<qty> <unit> (กำไร +฿XX.XX)
      const itemMatch = part.match(/^ขาย\s+(.+?)\s+x([\d,]+(?:\.\d+)?)\s*([^\(\s]+)?\s*\(กำไร\s*([+\-]?฿[\d,]+(?:\.\d+)?)\)$/);
      if (itemMatch) {
        return {
          type: 'item',
          name: itemMatch[1].trim(),
          qty: `×${itemMatch[2]}${itemMatch[3] ? ' ' + itemMatch[3] : ''}`,
          profit: itemMatch[4],
          isLoss: itemMatch[4].startsWith('-')
        };
      }
      return { type: 'text', text: part };
    });

    const structuredCount = parsedItems.filter(p => p.type !== 'text').length;
    if (structuredCount === 0) {
      return `
        <div class="figma-tx-note-row">
          <i data-lucide="message-square"></i>
          <span>${this.escapeHtml(raw)}</span>
        </div>
      `;
    }

    const safeId = String(cardKey || 'note').replace(/[^a-zA-Z0-9_-]/g, '_');
    const previewLimit = 6;
    const hasMore = parsedItems.length > previewLimit;

    const renderChip = (it) => {
      if (it.type === 'drink') {
        const profitColor = it.isLoss ? '#dc2626' : '#15803d';
        const profitBg = it.isLoss ? '#fef2f2' : '#f0fdf4';
        return `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:0.4rem; padding:0.35rem 0.55rem; background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; font-size:0.76rem; min-width:0;">
            <div style="min-width:0; flex:1;">
              <div style="font-weight:700; color:#1d4ed8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${this.escapeHtml(it.sub)}">
                🥤 ${this.escapeHtml(it.name)}
              </div>
              ${it.sub ? `<div style="font-size:0.68rem; color:#475569; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${this.escapeHtml(it.sub)}">${this.escapeHtml(it.sub)}</div>` : ''}
            </div>
            <span style="font-weight:700; color:${profitColor}; background:${profitBg}; padding:0.1rem 0.4rem; border-radius:999px; font-size:0.71rem; flex-shrink:0;">
              ${this.escapeHtml(it.profit)}
            </span>
          </div>
        `;
      }
      if (it.type === 'item') {
        const profitColor = it.isLoss ? '#dc2626' : '#15803d';
        const profitBg = it.isLoss ? '#fef2f2' : '#f0fdf4';
        const borderCol = it.isLoss ? '#fecaca' : '#e2e8f0';
        const bgCol = it.isLoss ? '#fffbfb' : '#ffffff';
        return `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:0.35rem; padding:0.32rem 0.55rem; background:${bgCol}; border:1px solid ${borderCol}; border-radius:8px; font-size:0.76rem; min-width:0;">
            <div style="display:flex; align-items:center; gap:0.3rem; min-width:0; flex:1;">
              <span style="font-weight:600; color:#1e293b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${this.escapeHtml(it.name)}">${this.escapeHtml(it.name)}</span>
              <span style="font-size:0.7rem; font-weight:700; color:#475569; background:#f1f5f9; padding:0.05rem 0.35rem; border-radius:5px; flex-shrink:0;">${this.escapeHtml(it.qty)}</span>
            </div>
            <span style="font-weight:700; color:${profitColor}; background:${profitBg}; padding:0.1rem 0.38rem; border-radius:999px; font-size:0.71rem; flex-shrink:0;">
              ${this.escapeHtml(it.profit)}
            </span>
          </div>
        `;
      }
      return `
        <div style="padding:0.32rem 0.55rem; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; font-size:0.75rem; color:#475569;">
          📝 ${this.escapeHtml(it.text)}
        </div>
      `;
    };

    const previewHtml = parsedItems.slice(0, previewLimit).map(renderChip).join('');
    const restHtml = hasMore ? parsedItems.slice(previewLimit).map(renderChip).join('') : '';

    return `
      <div style="margin-top:0.55rem; padding:0.55rem 0.7rem; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem; margin-bottom:0.45rem; flex-wrap:wrap;">
          <div style="display:flex; align-items:center; gap:0.4rem; font-size:0.75rem; font-weight:700; color:#334155;">
            <span>🧾 รายการขายวันนี้</span>
            <span style="background:#e2e8f0; color:#334155; padding:0.08rem 0.45rem; border-radius:999px; font-size:0.7rem;">${parsedItems.length} รายการ</span>
          </div>
          ${hasMore ? `
            <button type="button"
              onclick="const more=document.getElementById('dailyNoteMore_${safeId}'); const wrap=document.getElementById('dailyNoteGrid_${safeId}'); if(more){const show=more.style.display==='none'; more.style.display=show?'contents':'none'; if(wrap){wrap.style.maxHeight=show?'280px':'none'; wrap.style.overflowY=show?'auto':'visible';} this.textContent=show?'ย่อรายการ ▴':'ดูทั้งหมด (${parsedItems.length} รายการ) ▾';}"
              style="background:#ffffff; border:1px solid #cbd5e1; color:#2563eb; border-radius:999px; padding:0.15rem 0.6rem; font-size:0.72rem; font-weight:700; cursor:pointer;">
              ดูทั้งหมด (${parsedItems.length} รายการ) ▾
            </button>
          ` : ''}
        </div>
        <div id="dailyNoteGrid_${safeId}" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(215px, 1fr)); gap:0.35rem;">
          ${previewHtml}
          ${hasMore ? `<div id="dailyNoteMore_${safeId}" style="display:none;">${restHtml}</div>` : ''}
        </div>
      </div>
    `;
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
    const filter = document.getElementById('expenseCategoryFilter')?.value || 'ALL';
    const searchInput = document.getElementById('expenseSearchInput');
    const query = (searchInput?.value || '').toLowerCase().trim();
    let list = [...this.data.expenses];

    if (filter !== 'ALL') {
      list = list.filter(e => e.category === filter);
    }

    if (query) {
      list = list.filter(exp => {
        const title = String(exp.title || '').toLowerCase();
        const supplier = String(exp.supplier || '').toLowerCase();
        const note = String(exp.note || '').toLowerCase();
        const cat = String(exp.category || '').toLowerCase();
        const catThai = exp.category === 'INGREDIENT' ? 'วัตถุดิบชงน้ำ'
          : exp.category === 'PACKAGING' ? 'บรรจุภัณฑ์'
            : exp.category === 'FRIDGE_DRINK' ? 'น้ำขายในตู้ เครื่องดื่มแช่เย็น'
              : exp.category === 'STOCK' ? 'ยกลัง สินค้าสำเร็จรูป'
                : exp.category === 'PACK_SELL' ? 'ของแพ็คขาย'
                  : 'อื่นๆ ทั่วไป';
        const dateStr = String(exp.date || '');
        const thaiDate = this.formatThaiDate(exp.date, true).toLowerCase();
        const unit = String(exp.packUnit || '').toLowerCase();

        return title.includes(query)
          || supplier.includes(query)
          || note.includes(query)
          || cat.includes(query)
          || catThai.toLowerCase().includes(query)
          || dateStr.includes(query)
          || thaiDate.includes(query)
          || unit.includes(query);
      });
    }

    const totalAllExpenses = this.data.expenses.reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catIngredients = this.data.expenses.filter(e => e.category === 'INGREDIENT').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catPackaging = this.data.expenses.filter(e => e.category === 'PACKAGING').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catFridgeDrink = this.data.expenses.filter(e => e.category === 'FRIDGE_DRINK').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catStock = this.data.expenses.filter(e => e.category === 'STOCK').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catOther = this.data.expenses.filter(e => e.category === 'OTHER').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catPackSell = this.data.expenses.filter(e => e.category === 'PACK_SELL').reduce((a, b) => a + (Number(b.amount) || 0), 0);

    const totalEl = document.getElementById('expCategoryTotal');
    if (totalEl) totalEl.textContent = this.formatCurrency(totalAllExpenses);
    const countSubtextEl = document.getElementById('expTotalCountSubtext');
    if (countSubtextEl) countSubtextEl.textContent = `${this.data.expenses.length} รายการค่าใช้จ่าย`;

    const ingEl = document.getElementById('expCategoryIngredients'); if (ingEl) ingEl.textContent = this.formatCurrency(catIngredients);
    const packEl = document.getElementById('expCategoryPackaging'); if (packEl) packEl.textContent = this.formatCurrency(catPackaging);
    const stockEl = document.getElementById('expCategoryStock'); if (stockEl) stockEl.textContent = this.formatCurrency(catStock);
    const fridgeEl = document.getElementById('expCategoryFridgeDrink'); if (fridgeEl) fridgeEl.textContent = this.formatCurrency(catFridgeDrink);
    const otherEl = document.getElementById('expCategoryOther'); if (otherEl) otherEl.textContent = this.formatCurrency(catOther);
    const packSellEl = document.getElementById('expCategoryPackSell'); if (packSellEl) packSellEl.textContent = this.formatCurrency(catPackSell);

    const tbody = document.getElementById('expenseTableBody');
    const feedWrap = document.getElementById('expenseCardsFeed');
    const countBadge = document.getElementById('expenseFilteredCountBadge');

    if (countBadge) countBadge.textContent = `${list.length} รายการ`;

    if (list.length === 0) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">${query ? 'ไม่พบรายการที่ตรงกับคำค้นหา' : 'ไม่มีรายการค่าใช้จ่ายในหมวดหมู่นี้'}</td></tr>`;
      if (feedWrap) {
        feedWrap.innerHTML = `
          <div class="figma-tx-empty">
            <div class="figma-tx-empty-icon">
              <i data-lucide="${query ? 'search-x' : 'inbox'}"></i>
            </div>
            <div class="figma-tx-empty-title">${query ? 'ไม่พบรายการที่ตรงกับคำค้นหา' : 'ไม่มีรายการค่าใช้จ่ายในหมวดหมู่นี้'}</div>
            <div class="figma-tx-empty-desc">${query ? `ไม่พบข้อมูลที่ตรงกับ "${this.escapeHtml(query)}" ลองเปลี่ยนคำค้นหา หรือล้างช่องค้นหา` : 'กดปุ่ม "+ เพิ่มค่าใช้จ่าย" ด้านบนเพื่อเริ่มบันทึกบิลซื้อของ'}</div>
          </div>
        `;
      }
      this.refreshLucide();
      return;
    }

    const sortEl = document.getElementById('expenseSortOrder');
    const sortOrder = sortEl?.dataset?.order || sortEl?.value || 'newest';
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
        } else if (exp.category === 'FRIDGE_DRINK') {
          badgeClass = 'fridge';
          catName = 'น้ำขายในตู้';
          avatarClass = 'cat-fridge';
          iconName = 'snowflake';
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
        } else if (exp.category === 'PACK_SELL') {
          badgeClass = 'stock';
          catName = 'ของแพ็คขาย';
          avatarClass = 'cat-stock';
          iconName = 'package';
        }

        const pSize = Number(exp.packSize) || 0;
        const pUnit = exp.packUnit || '';
        const pricing = this.getExpenseUnitPricing(exp);
        const isBulk = pricing ? pricing.isBulk : false;

        let unitPriceStr = '';
        if (pricing && isBulk && pricing.itemsPerBulk > 1) {
          const crateCost = pSize > 0 ? (exp.amount / pSize) : exp.amount;
          unitPriceStr = `(฿${this.formatUnitCost(pricing.costPerPiece)}/${pricing.pieceName} | ${pUnit}ละ ฿${crateCost.toFixed(0)})`;
        } else if (pSize > 0 && exp.amount > 0) {
          const uCost = exp.amount / pSize;
          unitPriceStr = uCost < 1 ? `(฿${uCost.toFixed(2)}/${pUnit})` : `(฿${uCost.toFixed(1)}/${pUnit})`;
        }

        let qtyDisplay = exp.qtyDesc || (pSize > 0 ? `${pSize} ${pUnit}` : '');
        if (pricing && isBulk && pricing.itemsPerBulk > 1) {
          qtyDisplay = `${pSize} ${pUnit} (รวม ${pricing.totalPieces} ${pricing.pieceName} @ ${pricing.itemsPerBulk} ${pricing.pieceName}/${pUnit})`;
        }

        // ค้นหาข้อมูลสต๊อกคงเหลือปัจจุบันที่เชื่อมโยงกับรายการนี้
        const expTitleNorm = this.normalizeProductName(exp.title);
        const matchedStock = (this.data.stockItems || []).find(s => {
          if (!s || !s.name) return false;
          if (exp.stockItemId && String(s.id) === String(exp.stockItemId)) return true;
          return this.normalizeProductName(s.name) === expTitleNorm;
        });

        let stockBalanceBadge = '';
        if (matchedStock) {
          const curQty = Number(matchedStock.qty) || 0;
          const minQ = Number(matchedStock.minQty) || 0;
          const stockUnit = matchedStock.unit || (pricing ? pricing.pieceName : pUnit) || 'หน่วย';
          const isLow = minQ > 0 && curQty <= minQ;
          const badgeClass = isLow ? 'stock-badge-low' : 'stock-badge-normal';
          const badgeIcon = isLow ? '⚠️' : '📊';
          const badgeStyle = isLow
            ? 'background:#fef2f2; color:#dc2626; border:1px solid #fecaca; font-weight:700; border-radius:9999px; padding:0.15rem 0.5rem; font-size:0.75rem; display:inline-flex; align-items:center; gap:0.25rem;'
            : 'background:#f0fdf4; color:#16a34a; border:1px solid #bbf7d0; font-weight:700; border-radius:9999px; padding:0.15rem 0.5rem; font-size:0.75rem; display:inline-flex; align-items:center; gap:0.25rem;';

          let crateEquivText = '';
          const crateCap = Number(matchedStock.crateBottles) || (pricing && pricing.itemsPerBulk > 1 ? pricing.itemsPerBulk : 0);
          if (crateCap > 1) {
            const equiv = (curQty / crateCap).toFixed(2).replace(/\.?0+$/, '');
            crateEquivText = ` (~${equiv} ${matchedStock.rawUnit || pUnit || 'ลัง'})`;
          }
          stockBalanceBadge = `<span style="${badgeStyle}" title="ปริมาณคงเหลือในสต๊อกปัจจุบัน">${badgeIcon} คงเหลือในสต๊อก: <strong>${curQty} ${this.escapeHtml(stockUnit)}</strong>${crateEquivText}</span>`;
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
                  <div class="fec-meta-row" style="flex-wrap:wrap; gap:0.35rem; align-items:center;">
                    <span class="fec-date">${this.formatThaiDate(exp.date)}</span>
                    <span class="fec-badge ${badgeClass}">${catName}</span>
                    ${(() => {
            if (!exp.supplier) return '';
            const sup = this.parseSupplier(exp.supplier);
            if (sup.isUrl) {
              return `<a href="${this.escapeHtml(sup.url)}" target="_blank" rel="noopener noreferrer" 
                          class="pill-tag orange-tag" 
                          style="font-size:0.7rem; padding:0.1rem 0.45rem; text-decoration:none; display:inline-flex; align-items:center; gap:0.25rem; background:#ffedd5; color:#c2410c; border:1px solid #fed7aa; border-radius:9999px;" 
                          title="เปิดลิ้งก์สั่งซื้อ ${this.escapeHtml(sup.domain)}">
                          🛒 ${this.escapeHtml(sup.name)} <i data-lucide="external-link" style="width:10px;height:10px;"></i>
                        </a>`;
            }
            return `<span class="pill-tag orange-tag" style="font-size:0.7rem; padding:0.1rem 0.45rem; background:#ffedd5; color:#c2410c; border:1px solid #fed7aa; border-radius:9999px;">🛒 ${this.escapeHtml(exp.supplier)}</span>`;
          })()}
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

    document.querySelectorAll('#expensePillFilterGroup .figma-pill-filter').forEach(btn => {
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
      this.renderStockHistory();
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
      const isVacation = this.isVacationDay(dayDateStr);
      const vacationName = isVacation ? this.getVacationPeriodName(dayDateStr) : '';
      const isHol = isPublicHol || !!customHol || isVacation;

      const record = this.data.dailySales.find(d => d.date === dayDateStr);

      let dayTypeBadge = '';
      if (isVacation) {
        dayTypeBadge = `<span class="cal-vacation-badge" title="${this.escapeHtml(vacationName || 'ช่วงปิดเทอม')}">ปิดเทอม</span>`;
      } else if (customHol) {
        dayTypeBadge = `<span class="cal-custom-holiday-badge" title="${this.escapeHtml(customHol.reason || 'วันหยุดพิเศษ')}">หยุดพิเศษ</span>`;
      } else if (isPublicHol) {
        dayTypeBadge = '<span class="cal-holiday-badge" title="วันหยุดนักขัตฤกษ์">วันหยุด</span>';
      } else if (isWk) {
        dayTypeBadge = '<span class="cal-weekend-badge" title="วันหยุดเสาร์-อาทิตย์">ส-อา</span>';
      }

      cellsHtml += `
        <div class="cal-day-cell ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${isVacation ? 'vacation-day' : ''} ${isWk ? 'weekend-day' : ''} ${isPublicHol ? 'holiday-day' : ''} ${customHol ? 'custom-holiday-day' : ''}" onclick="app.selectCalendarDay('${dayDateStr}')">
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
            ` : (isVacation ? `<span class="text-muted" style="font-size:0.65rem; color:#8b5cf6; font-weight:600;">ปิดเทอม</span>` : (isWk || isHol ? `<span class="text-muted" style="font-size:0.65rem; color:${customHol ? '#ea580c' : '#94a3b8'};">${customHol ? 'หยุดพิเศษ' : 'หยุด'}</span>` : '<span class="text-muted" style="font-size:0.65rem;">-</span>'))}
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
    const isVacation = this.isVacationDay(dateStr);
    const vacationName = isVacation ? this.getVacationPeriodName(dateStr) : '';

    const title = document.getElementById('selectedDayTitle');
    if (title) {
      title.textContent = `ยอดขายวันที่ ${this.formatThaiDate(dateStr)}${isVacation ? ` (${vacationName || 'ปิดเทอม'})` : ''}`;
    }

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

    if (isVacation) {
      if (statusBadge) {
        statusBadge.className = 'badge-pill-item purple-tag';
        statusBadge.textContent = `🏖️ ปิดเทอม (${vacationName || 'ช่วงปิดเทอม'})`;
      }
      if (reasonNote) {
        reasonNote.style.display = 'block';
        reasonNote.innerHTML = `<strong>ช่วงเวลาปิดเทอม:</strong> ${this.escapeHtml(vacationName || 'โรงเรียนปิดภาคเรียน')} (ค่าเช่าร้าน = ฿0)`;
      }
      if (toggleBtn) {
        toggleBtn.className = 'btn-fastwork w-full btn-sm';
        toggleBtn.style.color = '#ffffff';
        toggleBtn.style.background = 'var(--amber, #f59e0b)';
        toggleBtn.style.borderColor = '#d97706';
      }
      if (toggleText) toggleText.textContent = '+ เพิ่มวันหยุดพิเศษ';
    } else if (customHol) {
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
      const isHol = isPubHol || !!customHol || isVacation;
      let emptyMsg = 'ยังไม่ได้บันทึกยอดขายของวันนี้';
      if (isVacation) emptyMsg = `วันนี้อยู่ในช่วงปิดเทอม: ${vacationName || 'โรงเรียนปิดภาคเรียน'}`;
      else if (customHol) emptyMsg = `วันนี้ถูกกำหนดเป็นวันหยุดพิเศษ: ${customHol.reason || 'น้ำท่วม/โรงเรียนปิด'}`;
      else if (isPubHol) emptyMsg = 'วันนี้เป็นวันหยุดนักขัตฤกษ์ / โรงเรียนปิด';
      else if (isWk) emptyMsg = 'วันหยุดสุดสัปดาห์ (เสาร์-อาทิตย์)';

      listContainer.innerHTML = `<p class="text-muted text-sm py-4 text-center">${this.escapeHtml(emptyMsg)}</p>`;
      return;
    }

    let dayStatusText = 'วันเปิดเรียนปกติ';
    if (isVacation) dayStatusText = `🏖️ ปิดเทอม: ${vacationName || 'ช่วงปิดเทอม'} (ค่าเช่า ฿0)`;
    else if (customHol) dayStatusText = `วันหยุดพิเศษ: ${customHol.reason || 'น้ำท่วม/โรงเรียนปิด'} (ค่าเช่า ฿0)`;
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

  // คำนวณต้นทุนต่อหน่วยบรรจุจริงของสินค้า/วัตถุดิบ (ขวด/กระป๋อง/ถุง/ชิ้น/kg/g/ml) ไม่ใช้ยอดเงินรวมทั้งบิล
  // ใช้ต้นทุนต่อ "หน่วยบรรจุ" (เช่น แพ็ค, ลัง, กล่อง) ไม่ใช่ต่อชิ้นย่อย เมื่อสินค้ามีหน่วยเป็น bulk
  getExpenseUnitPricing(exp) {
    if (!exp) return null;
    const amount = Number(exp.amount) || 0;
    const rawPackSize = Number(exp.packSize) || 1;
    const rawUnit = String(exp.packUnit || 'หน่วย').trim();
    const isBulk = rawUnit.includes('ลัง') || rawUnit.includes('แพ็ค') || rawUnit.includes('กล่อง') ||
      rawUnit.toLowerCase() === 'crate' || rawUnit.toLowerCase() === 'pack' || rawUnit.toLowerCase() === 'box';

    const crateBottles = Number(exp.crateBottles) || Number(exp.subUnitsPerPack) || 0;
    const itemsPerBulk = (isBulk && crateBottles > 0) ? crateBottles : 1;
    const totalPieces = (rawPackSize > 0 ? rawPackSize : 1) * itemsPerBulk;
    const costPerPiece = totalPieces > 0 ? (amount / totalPieces) : amount;

    // ชนิดหน่วยบรรจุย่อย (เช่น ขวด, กระป๋อง, ถุง, ชิ้น, ใบ)
    let pieceName = rawUnit;
    const lowerTitle = String(exp.title || '').toLowerCase();
    if (isBulk) {
      if (lowerTitle.includes('กระป๋อง') || lowerTitle.includes('กป')) {
        pieceName = 'กระป๋อง';
      } else if (lowerTitle.includes('แก้ว') || lowerTitle.includes('ฝา') || lowerTitle.includes('หลอด') || lowerTitle.includes('ถุงแก้ว')) {
        pieceName = 'ใบ';
      } else if (lowerTitle.includes('ถุง') || lowerTitle.includes('ห่อ')) {
        pieceName = 'ถุง';
      } else if (lowerTitle.includes('นม') || lowerTitle.includes('น้ำ') || lowerTitle.includes('ไซรัป') || lowerTitle.includes('ชา') || rawUnit.includes('ลัง')) {
        pieceName = 'ขวด';
      } else {
        pieceName = 'ชิ้น';
      }
    }

    const netWeight = Number(exp.netWeight) || 0;
    const netUnit = String(exp.netUnit || 'g').trim();

    let calcPrice = costPerPiece;
    let calcSize = 1;
    let calcUnit = pieceName;
    let badgeSpec = '';

    if (netWeight > 0) {
      calcPrice = costPerPiece;
      calcSize = netWeight;
      calcUnit = netUnit;
      badgeSpec = `${pieceName}ละ ฿${this.formatUnitCost(costPerPiece)} (${netWeight} ${netUnit})`;
    } else {
      calcPrice = costPerPiece;
      calcSize = 1;
      calcUnit = pieceName;
      badgeSpec = `${pieceName}ละ ฿${this.formatUnitCost(costPerPiece)}`;
    }

    // ต้นทุนต่อหน่วยบรรจุ (ต่อ ลัง/แพ็ค/กล่อง) — ไม่หารด้วยจำนวนชิ้นย่อย
    const costPerPack = rawPackSize > 0 ? (amount / rawPackSize) : amount;

    let costPerBaseUnit = 0; // per g or per ml
    if (netWeight > 0) {
      if (netUnit === 'kg' || netUnit === 'กก' || netUnit === 'ลิตร' || netUnit === 'l' || netUnit === 'liter') {
        costPerBaseUnit = costPerPiece / (netWeight * 1000);
      } else if (netUnit === 'g' || netUnit === 'กรัม' || netUnit === 'ml' || netUnit === 'มล') {
        costPerBaseUnit = costPerPiece / netWeight;
      }
    }

    return {
      amount,
      rawPackSize,
      rawUnit,
      isBulk,
      itemsPerBulk,
      totalPieces,
      costPerPiece,
      costPerPack,
      pieceName,
      netWeight,
      netUnit,
      calcPrice,
      calcSize,
      calcUnit,
      costPerBaseUnit,
      badgeSpec
    };
  }

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
          const pricing = this.getExpenseUnitPricing(matchedExp);
          const latestPrice = pricing ? pricing.calcPrice : (parseFloat(matchedExp.amount) || 0);
          const latestSize = pricing ? pricing.calcSize : (parseFloat(matchedExp.packSize) || 1);
          const latestUnit = pricing ? pricing.calcUnit : (matchedExp.packUnit || 'กรัม');

          let useAmount = ing.calcData?.useAmount !== undefined ? parseFloat(ing.calcData.useAmount) : 0;
          const ingAmountStr = String(ing.amount || '');
          const parsedIngAmount = parseFloat(ingAmountStr) || 0;
          const lowerName = (ing.name || '').toLowerCase();

          // ตรวจสอบการแปลงหน่วย: ถ้าสูตรเดิมระบุเป็น oz / g / ml / ช้อนโต๊ะ ให้แปลงเป็นหน่วยของวัตถุดิบ (latestUnit)
          if (ingAmountStr.includes('oz')) {
            const gPerOz = lowerName.includes('หวาน') ? 38.8 : (lowerName.includes('จืด') ? 31 : 30);
            if (latestUnit === 'kg' || latestUnit === 'กก') {
              useAmount = Math.round(((parsedIngAmount * gPerOz) / 1000) * 1000) / 1000;
            } else if (latestUnit === 'g' || latestUnit === 'กรัม') {
              useAmount = Math.round(parsedIngAmount * gPerOz * 10) / 10;
            } else if (latestUnit === 'ml' || latestUnit === 'มล') {
              useAmount = Math.round(parsedIngAmount * 29.57 * 10) / 10;
            } else if (latestUnit === 'l' || latestUnit === 'ลิตร' || latestUnit === 'liter') {
              useAmount = Math.round(((parsedIngAmount * 29.57) / 1000) * 1000) / 1000;
            } else if (latestUnit.includes('กป') || latestUnit.includes('กระป๋อง')) {
              useAmount = Math.round((parsedIngAmount / 13) * 100) / 100;
            } else if (latestUnit.includes('ขวด')) {
              useAmount = Math.round((parsedIngAmount / 33.8) * 100) / 100;
            }
          } else if (ingAmountStr.includes('g') || ingAmountStr.includes('กรัม')) {
            if (latestUnit === 'g' || latestUnit === 'กรัม') {
              useAmount = parsedIngAmount;
            } else if (latestUnit === 'kg' || latestUnit === 'กก') {
              useAmount = Math.round((parsedIngAmount / 1000) * 1000) / 1000;
            } else if (latestUnit.includes('ถุง') || latestUnit.includes('ห่อ') || latestUnit.includes('แพ็ค') || latestUnit === 'หน่วย') {
              const bagGrams = latestSize > 10 ? latestSize : 400;
              useAmount = Math.round((parsedIngAmount / bagGrams) * 1000) / 1000;
            }
          } else if (ingAmountStr.includes('ml') || ingAmountStr.includes('มล')) {
            if (latestUnit === 'ml' || latestUnit === 'มล') {
              useAmount = parsedIngAmount;
            } else if (latestUnit === 'l' || latestUnit === 'ลิตร' || latestUnit === 'liter') {
              useAmount = Math.round((parsedIngAmount / 1000) * 1000) / 1000;
            } else if (latestUnit === 'kg' || latestUnit === 'กก') {
              useAmount = Math.round((parsedIngAmount / 1000) * 1000) / 1000;
            } else if (latestUnit === 'g' || latestUnit === 'กรัม') {
              useAmount = parsedIngAmount;
            }
          } else if (ingAmountStr.includes('ช้อนโต๊ะ') || ingAmountStr.includes('tbsp')) {
            if (latestUnit === 'ml' || latestUnit === 'มล' || latestUnit === 'g' || latestUnit === 'กรัม') {
              useAmount = Math.round(parsedIngAmount * 15 * 10) / 10;
            } else if (latestUnit === 'l' || latestUnit === 'ลิตร' || latestUnit === 'liter' || latestUnit === 'kg' || latestUnit === 'กก') {
              useAmount = Math.round(((parsedIngAmount * 15) / 1000) * 1000) / 1000;
            }
          } else if (ingAmountStr.includes('ชุด') || ingAmountStr.includes('ใบ') || ingAmountStr.includes('ชิ้น') || ingAmountStr.includes('กระป๋อง') || ingAmountStr.includes('ขวด')) {
            useAmount = parsedIngAmount;
          }

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
            ing.calcData.useAmount = useAmount;
          }

          if (latestPrice > 0 && latestSize > 0 && useAmount > 0) {
            const updatedCost = Math.round(((latestPrice / latestSize) * useAmount) * 100) / 100;
            if (ing.cost !== updatedCost) {
              ing.cost = updatedCost;
              modified = true;
            }
          }
        } else if (Number(ing.cost) > 5000) {
          // หากไม่มี matchedExp แต่ต้นทุนเดิมสูงผิดปกติ (เช่น ชาไทย 35,136 บาท)
          const parsedIngAmount = parseFloat(String(ing.amount || '')) || 0;
          if (parsedIngAmount > 0) {
            // คำนวณราคาเฉลี่ยชาผง (~80 บาท / 400g = 0.2 บาท/g)
            const healedCost = Math.round(parsedIngAmount * 0.2 * 100) / 100;
            ing.cost = healedCost;
            modified = true;
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
    const cups = parseInt(recipe.yieldCups) || 24;
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

    const sortEl = document.getElementById('recipeSortOrder');
    const recipeSort = sortEl?.dataset?.order || sortEl?.value || 'newest';
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
      const yieldCups = isCup ? 1 : (recipe.yieldCups || 24);
      const sellingPrice = recipe.sellingPrice !== undefined ? Number(recipe.sellingPrice) : (recipe.suggestedPrice || 25);
      const profitPerCup = sellingPrice - unitCost;
      const marginPercent = sellingPrice > 0 ? Math.round(((profitPerCup / sellingPrice) * 100)) : 0;
      const totalJarProfit = profitPerCup * yieldCups;
      const isProfit = profitPerCup >= 0;

      const rawCap = recipe.jarCapacity || '1 โหล';
      const capacityText = isCup
        ? `ชงแก้ว ${recipe.cupSizeOz || 16} oz (ชงสด)`
        : (rawCap.includes('แก้ว') ? this.escapeHtml(rawCap) : `${this.escapeHtml(rawCap)} (~${yieldCups} แก้ว)`);

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
          <div class="frc-actions frc-actions-redesigned">
            <span class="frc-total-summary">
              ${isCup ? `กำไร +฿${profitPerCup.toFixed(2)} / แก้ว` : `กำไรหมดโหล ~${this.formatCurrency(totalJarProfit)}`}
            </span>
            <div class="frc-btns-group">
              <button type="button" class="frc-action-btn is-edit" onclick="app.openRecipeModal('${recipe.id}')" title="แก้ไขสูตร">
                <i data-lucide="edit-3"></i>
                <span>แก้ไข</span>
              </button>
              <button type="button" class="frc-action-btn is-delete" onclick="app.deleteRecipe('${recipe.id}')" title="ลบสูตร">
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

        // Net Weight / Volume per piece setup
        const netWeightInput = document.getElementById('expNetWeight');
        const netUnitInput = document.getElementById('expNetUnit');
        if (netWeightInput) {
          netWeightInput.value = (exp.netWeight !== undefined && exp.netWeight !== null && exp.netWeight !== '') ? exp.netWeight : '';
        }
        if (netUnitInput) {
          netUnitInput.value = exp.netUnit || (exp.category === 'FRIDGE_DRINK' ? 'ml' : 'g');
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
        const expTitleNorm = this.normalizeProductName(exp.title);
        const matched = (this.data.stockItems || []).find(s => {
          if (!s || !s.name) return false;
          if (exp.stockItemId && String(s.id) === String(exp.stockItemId)) return true;
          return this.normalizeProductName(s.name) === expTitleNorm;
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
      const netWeightInput = document.getElementById('expNetWeight');
      const netUnitInput = document.getElementById('expNetUnit');
      const expCatEl = document.getElementById('expCategory');
      if (netWeightInput) netWeightInput.value = '';
      if (netUnitInput) netUnitInput.value = (expCatEl && expCatEl.value === 'FRIDGE_DRINK') ? 'ml' : 'g';
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

    // Wire category change to set default net unit (ml for FRIDGE_DRINK)
    const expCategoryEl = document.getElementById('expCategory');
    if (expCategoryEl) {
      expCategoryEl.onchange = () => {
        const netUnitEl = document.getElementById('expNetUnit');
        const netWeightEl = document.getElementById('expNetWeight');
        if (expCategoryEl.value === 'FRIDGE_DRINK') {
          if (netUnitEl && (!netWeightEl?.value || netUnitEl.value === 'g')) {
            netUnitEl.value = 'ml';
          }
        } else if (netUnitEl && !netWeightEl?.value && netUnitEl.value === 'ml') {
          netUnitEl.value = 'g';
        }
        this.updateExpenseModalPreview();
      };
    }

    // Wire live preview calculation listeners
    ['expAmount', 'expPackSize', 'expPackUnit', 'expTitle', 'expCrateBottles', 'expMinQty', 'expPackUnitCustom', 'expNetWeight', 'expNetUnit'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.oninput = () => {
          if (id === 'expTitle') {
            this.handleExpenseTitleAutoFill();
          }
          this.updateExpenseModalPreview();
        };
        if (id === 'expPackUnit' || id === 'expNetUnit') {
          el.onchange = () => {
            if (id === 'expPackUnit') {
              const customInput = document.getElementById('expPackUnitCustom');
              if (el.value === 'CUSTOM') {
                if (customInput) {
                  customInput.style.display = 'block';
                  customInput.focus();
                }
              } else {
                if (customInput) customInput.style.display = 'none';
              }
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
      const netUnitEl = document.getElementById('expNetUnit');
      if (netUnitEl) {
        if (matched.netUnit) {
          netUnitEl.value = matched.netUnit;
        } else if (matched.category === 'FRIDGE_DRINK') {
          netUnitEl.value = 'ml';
        }
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

    const subUnitsLabel = document.getElementById('expSubUnitsLabel');
    const subUnitsAffix = document.getElementById('expSubUnitsAffix');
    const subUnitsHint = document.getElementById('expSubUnitsHint');

    const isBulk = unit.includes('ลัง') || unit.includes('แพ็ค') || unit.includes('กล่อง') ||
      unit.toLowerCase() === 'crate' || unit.toLowerCase() === 'pack' || unit.toLowerCase() === 'box';

    let pieceName = 'ขวด';
    if (titleVal.includes('กระป๋อง') || titleVal.includes('กป')) pieceName = 'กระป๋อง';
    else if (titleVal.includes('แก้ว') || titleVal.includes('ฝา') || titleVal.includes('หลอด')) pieceName = 'ใบ';
    else if (titleVal.includes('ถุง') || titleVal.includes('ห่อ')) pieceName = 'ถุง';
    else if (unit.includes('แพ็ค') || unit.includes('กล่อง')) pieceName = 'ชิ้น';
    else if (unit.includes('ลัง')) pieceName = 'ขวด';

    let bottlesPerCrate = 12;
    if (isBulk) {
      if (crateContainer) crateContainer.style.display = 'block';
      const crateBottlesVal = parseFloat(document.getElementById('expCrateBottles')?.value);
      bottlesPerCrate = !isNaN(crateBottlesVal) && crateBottlesVal > 0 ? crateBottlesVal : (unit.includes('ลัง') ? 12 : 6);

      if (subUnitsLabel) subUnitsLabel.innerHTML = `🍾 จำนวน${pieceName} ใน 1 ${unit} <span class="text-danger">*</span>`;
      if (subUnitsAffix) subUnitsAffix.textContent = `${pieceName}/${unit}`;
      if (subUnitsHint) subUnitsHint.textContent = `ระบุจำนวนชิ้น/ขวดต่อ ${unit} เพื่อคำนวณราคาต้นทุนต่อหน่วยบรรจุจริง`;

      // Summary inside crate container
      const totalBottles = packSize * bottlesPerCrate;
      const costPerBottle = totalBottles > 0 ? (amount / totalBottles) : 0;
      const netWeightVal = parseFloat(document.getElementById('expNetWeight')?.value) || 0;
      const netUnitVal = document.getElementById('expNetUnit')?.value || 'g';

      const summaryEl = document.getElementById('expCrateTotalBottlesSummary');
      if (summaryEl) {
        if (netWeightVal > 0) {
          const totalNet = totalBottles * netWeightVal;
          const costPerNet = totalNet > 0 ? (amount / totalNet) : 0;
          summaryEl.innerHTML = `<span style="color:#1d4ed8; font-weight:800;">ตก${pieceName}ละ ฿${this.formatUnitCost(costPerBottle)}</span> <span style="font-size:0.8rem; color:#64748b; font-weight:600;">(${netWeightVal} ${netUnitVal})</span><br><span style="font-size:0.8rem; color:#059669; font-weight:700;">เฉลี่ย ฿${this.formatUnitCost(costPerNet)} / ${netUnitVal} (รวม ${totalBottles} ${pieceName} = ${totalNet} ${netUnitVal})</span>`;
        } else {
          summaryEl.innerHTML = `<span style="color:#1d4ed8; font-weight:800;">ตก${pieceName}ละ ฿${this.formatUnitCost(costPerBottle)}</span> <span style="font-size:0.8rem; color:#64748b;">(รวม ${totalBottles} ${pieceName})</span>`;
        }
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

    const netWeightVal = parseFloat(document.getElementById('expNetWeight')?.value) || 0;
    const netUnitVal = document.getElementById('expNetUnit')?.value || 'g';

    if (costPreviewEl) {
      if (isBulk) {
        const totalBottles = packSize * bottlesPerCrate;
        const bottleCost = totalBottles > 0 ? (amount / totalBottles) : 0;
        const crateCost = packSize > 0 ? (amount / packSize) : 0;
        let previewHtml = `฿${this.formatUnitCost(bottleCost)} / ${pieceName} <span style="font-size:0.8rem; font-weight:normal; color:var(--text-muted);">(${unit}ละ ฿${crateCost.toFixed(2)})</span>`;
        if (netWeightVal > 0 && bottleCost > 0) {
          const costPerNet = bottleCost / netWeightVal;
          previewHtml += ` <span style="font-size:0.8rem; font-weight:700; color:#059669; background:#ecfdf5; padding:0.15rem 0.45rem; border-radius:4px; margin-left:0.3rem;">(ตก ฿${costPerNet.toFixed(2)} / ${netUnitVal})</span>`;
        }
        costPreviewEl.innerHTML = previewHtml;
      } else {
        const unitCost = packSize > 0 ? (amount / packSize) : 0;
        let previewHtml = `฿${this.formatUnitCost(unitCost)} / ${unit}`;
        if (netWeightVal > 0 && unitCost > 0) {
          const costPerNet = unitCost / netWeightVal;
          const displayCostPerNet = costPerNet < 0.01 ? costPerNet.toFixed(4) : costPerNet.toFixed(2);
          previewHtml += ` <span style="font-size:0.8rem; font-weight:700; color:#059669; background:#ecfdf5; padding:0.15rem 0.45rem; border-radius:4px; margin-left:0.3rem;">(ตก ฿${displayCostPerNet} / ${netUnitVal})</span>`;
        }
        costPreviewEl.innerHTML = previewHtml;
      }
    }

    if (syncStatusEl) {
      const editId = document.getElementById('expenseEditId')?.value;
      const titleNorm = this.normalizeProductName(titleVal);
      const matched = (this.data.stockItems || []).find(s => {
        if (!s || !s.name) return false;
        return this.normalizeProductName(s.name) === titleNorm;
      });

      const currentPricing = this.getExpenseUnitPricing({
        amount,
        packSize,
        packUnit: unit,
        crateBottles: bottlesPerCrate,
        title: titleVal,
        netWeight: netWeightVal,
        netUnit: netUnitVal
      });
      const isBulkUnit = currentPricing ? currentPricing.isBulk : false;
      const newPieces = currentPricing ? (isBulkUnit ? currentPricing.totalPieces : currentPricing.rawPackSize) : packSize;
      const pieceUnit = currentPricing ? currentPricing.pieceName : (matched ? matched.unit : unit);
      const costPerUnit = currentPricing ? currentPricing.costPerPiece : (packSize > 0 ? amount / packSize : 0);

      if (editId) {
        const oldExp = (this.data.expenses || []).find(e => e && String(e.id) === String(editId));
        const oldPricing = this.getExpenseUnitPricing(oldExp);
        const oldPieces = oldPricing ? oldPricing.rawPackSize : (Number(oldExp ? oldExp.packSize : 1) || 1);
        const diffPieces = newPieces - oldPieces;
        const diffStr = diffPieces > 0 ? `+${diffPieces}` : `${diffPieces}`;

        if (matched) {
          const currentQty = Number(matched.qty) || 0;
          const afterQty = Math.max(0, currentQty + diffPieces);
          const crateSub = (isBulk && bottlesPerCrate > 1) ? ` (บรรจุ ${bottlesPerCrate} ชิ้น/${unit})` : '';
          syncStatusEl.textContent = `🔄 อัปเดตสต๊อกเดิม "${matched.name}" (คงเหลือ ${currentQty} -> เป็น ${afterQty} ${pieceUnit}${crateSub} [${diffStr}])`;
          syncStatusEl.className = 'pill-tag blue-tag';
        } else {
          syncStatusEl.textContent = `🔄 อัปเดตและสร้างสต๊อกใหม่ "${titleVal || 'สินค้านี้'}" (${newPieces} ${pieceUnit})`;
          syncStatusEl.className = 'pill-tag green-tag';
        }
      } else {
        if (isBulk) {
          if (matched) {
            const currentQty = Number(matched.qty) || 0;
            const newQty = currentQty + newPieces;
            const crateSub = bottlesPerCrate > 1 ? ` (บรรจุ ${bottlesPerCrate} ชิ้น/${unit})` : '';
            syncStatusEl.textContent = `📦 เติมสต๊อกเดิม (ปัจจุบันมี ${currentQty} -> รับเพิ่ม +${newPieces} ${pieceUnit} เป็น ${newQty} ${pieceUnit}${crateSub})`;
            syncStatusEl.className = 'pill-tag blue-tag';
          } else if (titleVal) {
            syncStatusEl.textContent = `✨ สร้างเป็นสต๊อกใหม่ (+${newPieces} ${pieceUnit} @ ฿${this.formatUnitCost(costPerUnit)}/${pieceUnit})`;
            syncStatusEl.className = 'pill-tag green-tag';
          } else {
            syncStatusEl.textContent = `พร้อมรับเข้าคลัง ${newPieces} ${pieceUnit} อัตโนมัติ`;
            syncStatusEl.className = 'pill-tag green-tag';
          }
        } else {
          if (matched) {
            const currentQty = Number(matched.qty) || 0;
            const newQty = currentQty + newPieces;
            syncStatusEl.textContent = `📦 เติมสต๊อกเดิม (ปัจจุบันมี ${currentQty} -> เป็น ${newQty} ${pieceUnit})`;
            syncStatusEl.className = 'pill-tag blue-tag';
          } else if (titleVal) {
            syncStatusEl.textContent = `✨ สร้างเป็นสินค้าคงคลังใหม่ในสต๊อก (+${newPieces} ${pieceUnit} @ ฿${this.formatUnitCost(costPerUnit)}/${pieceUnit})`;
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

    const litersInput = document.getElementById('recJarLiters');

    if (isCup) {
      if (titleElem && !editIdInput.value) titleElem.textContent = 'สร้างสูตรชงน้ำใหม่ (ต่อ 1 แก้ว)';
      else if (titleElem) titleElem.textContent = 'แก้ไขสูตรชงน้ำต่อ 1 แก้ว';

      if (jarYieldSec) jarYieldSec.style.display = 'none';
      if (singleCupSec) singleCupSec.style.display = 'none';
      if (divider) divider.style.display = 'none';

      // ปลด required ของฟิลด์ที่ถูกซ่อนเพื่อไม่ให้บล็อกการ Submit ในโหมด 1 แก้ว
      if (litersInput) litersInput.removeAttribute('required');
      document.querySelectorAll('#singleCupContainer .single-cup-row input').forEach(inp => {
        inp.removeAttribute('required');
      });

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

      if (litersInput) litersInput.setAttribute('required', 'required');
      document.querySelectorAll('#singleCupContainer .single-cup-row input').forEach(inp => {
        inp.setAttribute('required', 'required');
      });

      if (batchTitle) batchTitle.textContent = 'รายการส่วนผสมต่อ 1 โหล/ถัง:';
      if (batchHint) batchHint.textContent = 'ระบุวัตถุดิบที่ใช้ผสมใน 1 โหล/ถัง (หรือกำหนดสัดส่วน 1 แก้วด้านบน แล้วกด "⚡ คำนวณขยายสูตรลง 1 โหล" เพื่อคำนวณลงมาอัตโนมัติ)';
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

      if (litersInput && (!litersInput.value || parseFloat(litersInput.value) <= 0)) {
        litersInput.value = 6;
      }
      this.calculateAutoYield();
    }

    this.updateRecipeModalCalculations();
  }

  checkSingleCupEmptyState() {
    const container = document.getElementById('singleCupContainer');
    if (!container) return;
    const rows = container.querySelectorAll('.single-cup-row');
    const existingNotice = document.getElementById('singleCupEmptyNotice');
    if (rows.length === 0) {
      if (!existingNotice) {
        const notice = document.createElement('div');
        notice.id = 'singleCupEmptyNotice';
        notice.style.cssText = 'text-align:center; padding:1.15rem 1rem; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:var(--radius-sm); color:var(--text-muted); font-size:0.83rem; line-height:1.5;';
        notice.innerHTML = `
          💡 <b>ยังไม่มีการระบุสัดส่วน 1 แก้ว</b><br>
          <span style="font-size:0.78rem; color:#64748b;">(หากชงเป็นถังโดยตรง สามารถกรอกที่ <b>รายการส่วนผสมต่อ 1 โหล/ถัง</b> ด้านล่างได้เลย หรือกดปุ่ม <b>"+ เพิ่มวัตถุดิบแก้ว"</b> ด้านบนหากต้องการให้ระบบคำนวณสเกลขยายสูตรลงโหลอัตโนมัติ)</span>
        `;
        container.appendChild(notice);
      }
    } else {
      if (existingNotice) {
        existingNotice.remove();
      }
    }
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
        const litersElem = document.getElementById('recJarLiters');
        if (litersElem) {
          litersElem.value = rec.jarLiters || 6;
          litersElem._lastLiters = rec.jarLiters || 6;
        }
        document.getElementById('recCupSizeOz').value = rec.cupSizeOz || 16;
        document.getElementById('recInstructions').value = rec.instructions || '';
        const priceInput = document.getElementById('recSellingPrice');
        if (priceInput) {
          priceInput.value = rec.sellingPrice !== undefined ? rec.sellingPrice : (rec.suggestedPrice || 25);
          const tpInput = document.getElementById('recTargetProfit');
          if (tpInput) tpInput.value = rec.targetProfit !== undefined ? rec.targetProfit : 5;
        }

        // ดึงสัดส่วน 1 แก้ว (ถ้ามีบันทึกไว้) ไม่ใส่สูตรชาเริ่มต้นหากไม่มี
        if (rec.singleCupProportions && rec.singleCupProportions.length > 0) {
          rec.singleCupProportions.forEach(cupItem => {
            this.addSingleCupRow(cupItem.name, cupItem.amount, cupItem.unit);
          });
        }
        this.checkSingleCupEmptyState();

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
      const litersElem = document.getElementById('recJarLiters');
      if (litersElem) {
        litersElem.value = activeMode === 'cup' ? 0 : 6;
        litersElem._lastLiters = activeMode === 'cup' ? 0 : 6;
      }
      document.getElementById('recCupSizeOz').value = 16;
      const yieldInput = document.getElementById('recYieldCups');
      if (yieldInput) yieldInput.value = activeMode === 'cup' ? 1 : 24;
      const priceInput = document.getElementById('recSellingPrice');
      if (priceInput) priceInput.value = '';
      const tpInput = document.getElementById('recTargetProfit');
      if (tpInput) tpInput.value = 5;

      // สูตรใหม่: ปล่อยให้ singleCupContainer ว่างไว้ก่อน ไม่ต้องใส่สูตรชาเริ่มต้น
      this.checkSingleCupEmptyState();
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

    const updateYieldAndBatch = () => {
      const cupOz = parseInt(document.getElementById('recCupSizeOz')?.value) || 16;
      document.querySelectorAll('#singleCupContainer .single-cup-row .cup-ing-name').forEach(inp => {
        if (inp.value && (inp.value.includes('แก้ว + ฝา + หลอด') || inp.value.includes('แก้ว+ฝา+หลอด') || (inp.value.includes('แก้ว') && inp.value.includes('oz')))) {
          inp.value = `แก้ว + ฝา + หลอด (${cupOz} oz)`;
        }
      });
      const newYield = this.calculateAutoYield();
      const currentLiters = parseFloat(document.getElementById('recJarLiters')?.value) || 0;

      // ตรวจสอบว่ามีแถววัตถุดิบ 1 แก้วที่กรอกข้อมูลไว้หรือไม่
      const cupRows = document.querySelectorAll('#singleCupContainer .single-cup-row');
      let hasValidSingleCup = false;
      cupRows.forEach(row => {
        const n = (row.querySelector('.cup-ing-name')?.value || '').trim();
        const a = parseFloat(row.querySelector('.cup-ing-amount')?.value) || 0;
        if (n && a > 0) hasValidSingleCup = true;
      });

      // ตรวจสอบว่ามีแถวส่วนผสมของโหลอยู่หรือไม่
      const batchRows = document.querySelectorAll('#recipeIngredientsContainer .ingredient-row');

      if (hasValidSingleCup && batchRows.length > 0) {
        // หากผู้ใช้เคยคำนวณจากสูตร 1 แก้ว ให้ขยายสัดส่วนลงถังใหม่ตามจำนวนแก้ว (newYield) และลิตร (currentLiters)
        this.syncCupProportionsToBatch(false);
      } else if (!hasValidSingleCup && batchRows.length > 0) {
        // หากผู้ใช้ป้อนส่วนผสมต่อโหลโดยตรง ให้ปรับสเกลปริมาณและต้นทุนตามสัดส่วนลิตรที่เปลี่ยนไป
        const prevLiters = litersInput?._lastLiters || currentLiters;
        if (prevLiters > 0 && currentLiters > 0 && prevLiters !== currentLiters) {
          const ratio = currentLiters / prevLiters;
          this.scaleBatchIngredientsDirectly(ratio, newYield);
        }
      }

      if (litersInput) litersInput._lastLiters = currentLiters;
      this.updateRecipeModalCalculations();
    };

    // เชื่อมต่อปุ่มเลือกปริมาตรด่วน (5 ลิตร, 6 ลิตร, 8 ลิตร, 10 ลิตร)
    document.querySelectorAll('.btn-liter-preset').forEach(btn => {
      if (!btn._boundPreset) {
        btn._boundPreset = true;
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const lit = parseFloat(btn.dataset.liters) || 6;
          if (litersInput) {
            litersInput.value = lit;
            updateYieldAndBatch();
          }
        });
      }
    });

    if (litersInput && !litersInput._boundYield) {
      litersInput._boundYield = true;
      litersInput.addEventListener('input', updateYieldAndBatch);
      litersInput.addEventListener('change', updateYieldAndBatch);
      litersInput.addEventListener('keyup', updateYieldAndBatch);
    }
    if (cupSizeSelect && !cupSizeSelect._boundYield) {
      cupSizeSelect._boundYield = true;
      cupSizeSelect.addEventListener('change', updateYieldAndBatch);
      cupSizeSelect.addEventListener('input', updateYieldAndBatch);
    }
    if (priceInput && !priceInput._boundPrice) {
      priceInput._boundPrice = true;
      const targetProfitInput = document.getElementById('recTargetProfit');
      if (targetProfitInput && !targetProfitInput._boundTargetProfit) {
        targetProfitInput._boundTargetProfit = true;
        targetProfitInput.addEventListener('input', () => this.updateRecipeModalCalculations());
      }
      priceInput.addEventListener('input', () => {
        this.updateRecipeModalCalculations();
      });
    }

    modal.classList.add('active');
  }

  addSingleCupRow(name = '', amount = 1, unit = 'oz') {
    const container = document.getElementById('singleCupContainer');
    if (!container) return;

    // ลบข้อความแจ้งเตือนสถานะว่างออกเมื่อเริ่มเพิ่มแถว
    const emptyNotice = document.getElementById('singleCupEmptyNotice');
    if (emptyNotice) emptyNotice.remove();

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
        <option value="ลูก" ${unit === 'ลูก' ? 'selected' : ''}>ลูก (ผลไม้)</option>
        <option value="ช้อนโต๊ะ" ${unit === 'ช้อนโต๊ะ' ? 'selected' : ''}>ช้อนโต๊ะ (tbsp)</option>
        <option value="ชุด" ${unit === 'ชุด' ? 'selected' : ''}>ชุด (แก้ว/ฝา)</option>
        <option value="ชิ้น" ${unit === 'ชิ้น' ? 'selected' : ''}>ชิ้น/หน่วย</option>
      </select>
      <button type="button" class="btn-icon-danger" title="ลบรายการนี้">&times;</button>
    `;

    row.querySelector('.btn-icon-danger').addEventListener('click', () => {
      row.remove();
      this.checkSingleCupEmptyState();
    });

    container.appendChild(row);
  }

  syncCupProportionsToBatch(showNotification = true) {
    const cupRows = document.querySelectorAll('#singleCupContainer .single-cup-row');
    if (cupRows.length === 0) {
      if (showNotification) {
        this.showToast('⚠️ กรุณากด "+ เพิ่มวัตถุดิบแก้ว" และกำหนดส่วนผสม 1 แก้วก่อนคำนวณขยายสูตร', 'info');
      }
      return;
    }

    const hasValidItem = Array.from(cupRows).some(r => {
      const name = (r.querySelector('.cup-ing-name')?.value || '').trim();
      const amount = parseFloat(r.querySelector('.cup-ing-amount')?.value) || 0;
      return name && amount > 0;
    });

    if (!hasValidItem) {
      if (showNotification) {
        this.showToast('⚠️ กรุณาระบุชื่อและปริมาณวัตถุดิบ 1 แก้วอย่างน้อย 1 รายการก่อนคำนวณขยายสูตร', 'info');
      }
      return;
    }

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
      } else if (unit === 'ช้อนโต๊ะ' || unit === 'tbsp') {
        // 1 ช้อนโต๊ะ ~ 15 ml
        singleCupLiquidMl += (amount * 15);
      } else if (unit === 'g') {
        if (name.includes('ชา') || name.includes('กาแฟ') || name.includes('โกโก้')) {
          hasTeaPowderItem = true;
        }
      }
    });

    // หากในสูตรมีผงชาแต่ไม่มีแถวน้ำชาสกัด (ml) ให้เพิ่มน้ำชาสกัดมาตรฐาน 60 ml อัตโนมัติ เพื่อให้ของเหลวสมบูรณ์
    if (hasTeaPowderItem && !hasTeaShotItem) {
      singleCupLiquidMl += 100;
    }

    // เกณฑ์มาตรฐานร้าน: 1 แก้วใช้น้ำชง 250 ml รวมน้ำแข็งแล้ว
    if (singleCupLiquidMl < 50) {
      singleCupLiquidMl = 250;
    }

    // 2. ตัวคูณขยายสูตรลงถัง (Batch Multiplier) ยึดตามจำนวนแก้วที่ชงเสิร์ฟได้จริง (yieldCups เช่น ถัง 5L = 20 แก้ว, ถัง 6L = 24 แก้ว)
    const yieldCups = this.calculateAutoYield();
    const batchScaleMultiplier = yieldCups;

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
        const pricing = this.getExpenseUnitPricing(matchedExp);
        const packPrice = pricing ? pricing.calcPrice : (Number(matchedExp.amount) || 0);
        let packSize = pricing ? pricing.calcSize : (Number(matchedExp.packSize) || 1);
        let packUnit = pricing ? pricing.calcUnit : (matchedExp.packUnit || '');

        // คำนวณปริมาณใช้ในหน่วยแพ็กที่ซื้อมา (useInPackUnit) โดยรักษาหน่วยของสูตรเดิมไว้
        let useInPackUnit = recipeAmountVal;

        if (unit === 'g' && (packUnit === 'g' || packUnit === 'กรัม')) {
          useInPackUnit = recipeAmountVal;
          displayAmount = `${recipeAmountVal} กรัม`;
        } else if (unit === 'g' && (packUnit === 'kg' || packUnit === 'กก')) {
          useInPackUnit = Math.round((recipeAmountVal / 1000) * 1000) / 1000;
          displayAmount = `${recipeAmountVal} กรัม (~${useInPackUnit} kg)`;
        } else if (unit === 'g' && (packUnit.includes('ถุง') || packUnit.includes('ห่อ') || packUnit.includes('แพ็ค') || packUnit === 'หน่วย' || packUnit === '')) {
          const bagWeight = (packSize > 10 ? packSize : 400);
          useInPackUnit = Math.round((recipeAmountVal / bagWeight) * 1000) / 1000;
          displayAmount = `${recipeAmountVal} g (~${useInPackUnit} ${packUnit || 'ถุง'})`;
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
          // แปลงจาก oz เป็น kg: 1 oz นมข้นหวาน ~38.8g, นมจืด/นมสด ~31g
          const gPerOz = lowerName.includes('หวาน') ? 38.8 : (lowerName.includes('จืด') ? 31 : 30);
          useInPackUnit = Math.round(((recipeAmountVal * gPerOz) / 1000) * 1000) / 1000;
          displayAmount = `${recipeAmountVal} oz (~${useInPackUnit} kg)`;
        } else if (unit === 'ml' && (packUnit === 'ml' || packUnit === 'มล')) {
          useInPackUnit = recipeAmountVal;
          displayAmount = `${recipeAmountVal} ml`;
        } else if (unit === 'ml' && (packUnit === 'ลิตร' || packUnit === 'l' || packUnit === 'liter')) {
          useInPackUnit = Math.round((recipeAmountVal / 1000) * 1000) / 1000;
          displayAmount = `${recipeAmountVal} ml (~${useInPackUnit} ลิตร)`;
        } else if (unit === 'ml' && (packUnit === 'kg' || packUnit === 'กก')) {
          useInPackUnit = Math.round((recipeAmountVal / 1000) * 1000) / 1000;
          displayAmount = `${recipeAmountVal} ml (~${useInPackUnit} kg)`;
        } else if (unit === 'ml' && (packUnit === 'g' || packUnit === 'กรัม')) {
          useInPackUnit = recipeAmountVal;
          displayAmount = `${recipeAmountVal} ml (~${useInPackUnit} g)`;
        } else if (unit === 'ช้อนโต๊ะ' || unit === 'tbsp') {
          // 1 ช้อนโต๊ะ ~ 15 ml หรือ ~15g
          if (packUnit === 'ml' || packUnit === 'มล') {
            useInPackUnit = Math.round(recipeAmountVal * 15 * 10) / 10;
            displayAmount = `${recipeAmountVal} ช้อนโต๊ะ (~${useInPackUnit} ml)`;
          } else if (packUnit === 'l' || packUnit === 'ลิตร' || packUnit === 'liter') {
            useInPackUnit = Math.round(((recipeAmountVal * 15) / 1000) * 1000) / 1000;
            displayAmount = `${recipeAmountVal} ช้อนโต๊ะ (~${useInPackUnit} ลิตร)`;
          } else if (packUnit === 'g' || packUnit === 'กรัม') {
            useInPackUnit = Math.round(recipeAmountVal * 15 * 10) / 10;
            displayAmount = `${recipeAmountVal} ช้อนโต๊ะ (~${useInPackUnit} g)`;
          } else if (packUnit === 'kg' || packUnit === 'กก') {
            useInPackUnit = Math.round(((recipeAmountVal * 15) / 1000) * 1000) / 1000;
            displayAmount = `${recipeAmountVal} ช้อนโต๊ะ (~${useInPackUnit} kg)`;
          } else if (packUnit.includes('ถุง') || packUnit.includes('ห่อ') || packUnit.includes('แพ็ค')) {
            const bagWeight = (packSize > 10 ? packSize : 400);
            useInPackUnit = Math.round(((recipeAmountVal * 15) / bagWeight) * 1000) / 1000;
            displayAmount = `${recipeAmountVal} ช้อนโต๊ะ (~${useInPackUnit} ${packUnit || 'ถุง'})`;
          } else {
            useInPackUnit = recipeAmountVal;
            displayAmount = `${recipeAmountVal} ช้อนโต๊ะ`;
          }
        } else if (unit === 'ลูก' || unit === 'ชิ้น') {
          useInPackUnit = recipeAmountVal;
          displayAmount = `${recipeAmountVal} ${unit}`;
        } else if (isPackaging) {
          useInPackUnit = recipeAmountVal;
          displayAmount = `${recipeAmountVal} ${packUnit || 'ชุด'}`;
        } else {
          // หากหน่วยของสูตรเป็น g แต่ packUnit ไม่ตรง
          if (unit === 'g' && packSize > 0) {
            useInPackUnit = Math.round((recipeAmountVal / (packSize > 10 ? packSize : 400)) * 1000) / 1000;
            displayAmount = `${recipeAmountVal} g`;
          } else if (unit === 'ml' && packSize > 0) {
            useInPackUnit = Math.round((recipeAmountVal / (packSize > 10 ? packSize : 1000)) * 1000) / 1000;
            displayAmount = `${recipeAmountVal} ml`;
          } else {
            useInPackUnit = recipeAmountVal;
            displayAmount = `${recipeAmountVal} ${unit}`;
          }
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
    const litersInput = document.getElementById('recJarLiters');
    const liters = litersInput ? (parseFloat(litersInput.value) || 0) : 6;
    const cupOz = parseInt(document.getElementById('recCupSizeOz')?.value) || 16;

    // เกณฑ์มาตรฐานร้าน: แก้ว 16 oz ใช้น้ำชง 250 ml (รวมน้ำแข็งเต็มแก้ว)
    // สัดส่วนขนาดแก้วอื่นคำนวณตามขนาด oz (oz * (250 / 16)):
    // - 16 oz: 250 ml (ถัง 5L ได้ 20 แก้ว | ถัง 6L ได้ 24 แก้ว)
    // - 20 oz: ~312.5 ml (ถัง 5L ได้ ~16 แก้ว | ถัง 6L ได้ ~19 แก้ว)
    // - 22 oz: ~343.8 ml (ถัง 5L ได้ ~15 แก้ว | ถัง 6L ได้ ~17 แก้ว)
    // - 28 oz: ~437.5 ml (ถัง 5L ได้ ~11 แก้ว | ถัง 6L ได้ ~14 แก้ว)
    // - 32 oz: 500 ml (ถัง 5L ได้ 10 แก้ว | ถัง 6L ได้ 12 แก้ว)
    const liquidPerCupMap = {
      10: 156.25,
      12: 187.5,
      16: 250,
      20: 312.5,
      22: 343.75,
      28: 437.5,
      32: 500
    };

    const mlPerCup = liquidPerCupMap[cupOz] || (cupOz * (250 / 16));
    const totalMl = liters > 0 ? (liters * 1000) : 0;
    const calculatedCups = liters > 0 ? Math.max(1, Math.round(totalMl / mlPerCup)) : 0;

    const yieldInput = document.getElementById('recYieldCups');
    const jarCapacityInput = document.getElementById('recJarCapacity');
    const hintText = document.getElementById('recYieldHintText');
    const scaleBadge = document.getElementById('cupScaleCountBadge');

    if (yieldInput && liters > 0) yieldInput.value = calculatedCups;
    if (scaleBadge && liters > 0) scaleBadge.textContent = calculatedCups;
    if (jarCapacityInput && liters > 0) {
      jarCapacityInput.value = `โหล/ถัง ${liters} ลิตร (แก้ว ${cupOz} oz ได้ ~${calculatedCups} แก้ว)`;
    }
    if (hintText && liters > 0) {
      const displayMl = Math.round(mlPerCup);
      hintText.textContent = `น้ำชง ${liters} ลิตร (${totalMl.toLocaleString()} ml) เสิร์ฟแก้ว ${cupOz} oz รวมน้ำแข็งเต็มแก้ว (ใช้น้ำชง ${displayMl === 250 ? '250' : '~' + displayMl} ml/แก้ว) ชงเสิร์ฟได้ ~${calculatedCups} แก้ว`;
    }

    return calculatedCups || (liters === 5 ? 20 : 24);
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
    let amountUnit = 'g';

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
      amountUnit = 'g';
    }

    const row = document.createElement('div');
    row.className = 'ingredient-row';

    let pPrice = calcData ? (calcData.packPrice || '') : '';
    let pSize = calcData ? (calcData.packSize || '') : '';
    let pUnit = calcData ? (calcData.packUnit || amountUnit || 'กรัม') : (amountUnit || 'กรัม');
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
        const pricing = this.getExpenseUnitPricing(latestExp);
        if (pricing) {
          pPrice = pricing.calcPrice;
          pSize = pricing.calcSize;
          pUnit = pricing.calcUnit;
        } else {
          pPrice = parseFloat(latestExp.amount) || 0;
          if (latestExp.netWeight && Number(latestExp.netWeight) > 0) {
            const packMulti = Number(latestExp.packSize) > 0 ? Number(latestExp.packSize) : 1;
            pSize = packMulti * Number(latestExp.netWeight);
            pUnit = latestExp.netUnit || 'g';
          } else {
            if (latestExp.packSize) pSize = parseFloat(latestExp.packSize) || pSize;
            if (latestExp.packUnit) pUnit = latestExp.packUnit;
          }
        }

        // หากมี amountVal และ amountUnit ในสูตร ให้ตรวจสอบและคำนวณ useAmount ให้ตรงกับหน่วยบรรจุภัณฑ์จริง (pUnit)
        const parsedAmt = parseFloat(amountVal) || 0;
        const lowerRowName = (name || '').toLowerCase();
        if (parsedAmt > 0) {
          if (amountUnit === 'oz') {
            const gPerOz = lowerRowName.includes('หวาน') ? 38.8 : (lowerRowName.includes('จืด') ? 31 : 30);
            if (pUnit === 'kg' || pUnit === 'กก') {
              pUse = Math.round(((parsedAmt * gPerOz) / 1000) * 1000) / 1000;
            } else if (pUnit === 'g' || pUnit === 'กรัม') {
              pUse = Math.round(parsedAmt * gPerOz * 10) / 10;
            } else if (pUnit === 'ml' || pUnit === 'มล') {
              pUse = Math.round(parsedAmt * 29.57 * 10) / 10;
            } else if (pUnit === 'l' || pUnit === 'ลิตร' || pUnit === 'liter') {
              pUse = Math.round(((parsedAmt * 29.57) / 1000) * 1000) / 1000;
            } else if (pUnit.includes('กป') || pUnit.includes('กระป๋อง')) {
              pUse = Math.round((parsedAmt / 13) * 100) / 100;
            } else if (pUnit.includes('ขวด')) {
              pUse = Math.round((parsedAmt / 33.8) * 100) / 100;
            }
          } else if (amountUnit === 'g' || amountUnit === 'กรัม') {
            if (pUnit === 'kg' || pUnit === 'กก') {
              pUse = Math.round((parsedAmt / 1000) * 1000) / 1000;
            } else if (pUnit === 'g' || pUnit === 'กรัม') {
              pUse = parsedAmt;
            } else if (pUnit.includes('ถุง') || pUnit.includes('ห่อ') || pUnit.includes('แพ็ค') || pUnit === 'หน่วย') {
              const bagGrams = pSize > 10 ? pSize : 400;
              pUse = Math.round((parsedAmt / bagGrams) * 1000) / 1000;
            }
          } else if (amountUnit === 'ml' || amountUnit === 'มล') {
            if (pUnit === 'l' || pUnit === 'ลิตร' || pUnit === 'liter' || pUnit === 'kg' || pUnit === 'กก') {
              pUse = Math.round((parsedAmt / 1000) * 1000) / 1000;
            } else if (pUnit === 'ml' || pUnit === 'มล' || pUnit === 'g' || pUnit === 'กรัม') {
              pUse = parsedAmt;
            }
          } else if (amountUnit === 'ลูก' || amountUnit === 'ชิ้น' || amountUnit === 'ชุด') {
            pUse = parsedAmt;
          }
        }

        if (pUse > 0 && pPrice > 0 && pSize > 0) {
          cost = Math.round(((pPrice / pSize) * pUse) * 100) / 100;
        }
      }
    }

    const hasCalc = (pPrice !== '' && pPrice > 0) || (pSize !== '' && pSize > 0) || Boolean(calcData);
    const isCupMode = document.getElementById('recMode')?.value === 'cup';

    const standardUnits = ['oz', 'ml', 'g', 'ลูก', 'ช้อนโต๊ะ', 'ชุด', 'ชิ้น'];
    const currentUnit = amountUnit || 'g';
    const isCustomUnit = currentUnit && !standardUnits.includes(currentUnit);

    row.innerHTML = `
      <div class="ingredient-row-main">
        <input type="text" class="form-input ing-name" placeholder="ชื่อวัตถุดิบ (เช่น ผงชาไทย, แก้ว+ฝา)" value="${this.escapeHtml(name)}" required>
        <div style="display:flex; gap:0.35rem; align-items:center;">
          <input type="number" step="any" min="0" class="form-input ing-amount" placeholder="ปริมาณ" value="${this.escapeHtml(String(amountVal))}" style="flex:1; min-width:65px; padding-left:0.6rem; padding-right:0.4rem; font-weight:600; color:var(--text-main);">
          <select class="form-input ing-amount-unit" style="flex:1; min-width:85px; padding:0.35rem 0.4rem; font-size:0.8rem; font-weight:700; color:var(--primary); background:#ffffff; cursor:pointer;" title="เลือกหน่วยวัด">
            <option value="oz" ${currentUnit === 'oz' ? 'selected' : ''}>oz</option>
            <option value="ml" ${currentUnit === 'ml' ? 'selected' : ''}>ml</option>
            <option value="g" ${currentUnit === 'g' ? 'selected' : ''}>กรัม (g)</option>
            <option value="ลูก" ${currentUnit === 'ลูก' ? 'selected' : ''}>ลูก</option>
            <option value="ช้อนโต๊ะ" ${currentUnit === 'ช้อนโต๊ะ' ? 'selected' : ''}>ช้อนโต๊ะ</option>
            <option value="ชุด" ${currentUnit === 'ชุด' ? 'selected' : ''}>ชุด</option>
            <option value="ชิ้น" ${currentUnit === 'ชิ้น' ? 'selected' : ''}>ชิ้น</option>
            ${isCustomUnit ? `<option value="${this.escapeHtml(currentUnit)}" selected>${this.escapeHtml(currentUnit)}</option>` : ''}
          </select>
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
              ${(this.data.expenses || []).filter(exp => this.isExpenseAvailableForSelection(exp)).map(exp => {
      const pricing = this.getExpenseUnitPricing(exp);
      const isSelected = selectedExpId && selectedExpId === exp.id ? 'selected' : '';
      const unitPrice = pricing ? pricing.calcPrice : (Number(exp.amount) || 0);
      const unitSize = pricing ? pricing.calcSize : (Number(exp.packSize) || 1);
      const unitUnit = pricing ? pricing.calcUnit : (exp.packUnit || 'หน่วย');
      const badgeSpec = pricing ? pricing.badgeSpec : `฿${exp.amount}`;
      const displayText = pricing && pricing.isBulk
        ? `${exp.title} (${badgeSpec} | บิล ฿${exp.amount})`
        : `${exp.title} (${badgeSpec})`;

      return `<option value="${exp.id}" ${isSelected}
                  data-title="${this.escapeHtml(exp.title)}" 
                  data-amount="${exp.amount}" 
                  data-unitprice="${unitPrice}" 
                  data-unitsize="${unitSize}" 
                  data-unitunit="${this.escapeHtml(unitUnit)}" 
                  data-badgespec="${this.escapeHtml(badgeSpec)}" 
                  data-qty="${this.escapeHtml(exp.qtyDesc || '')}" 
                  data-packsize="${exp.packSize || ''}" 
                  data-packunit="${this.escapeHtml(exp.packUnit || '')}" 
                  data-netweight="${exp.netWeight || ''}" 
                  data-netunit="${this.escapeHtml(exp.netUnit || '')}" 
                  data-note="${this.escapeHtml(exp.note || '')}">
                  ${this.escapeHtml(displayText)}
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
          ${hasCalc && pPrice > 0 ? `💡 ต้นทุน ฿${Number(pPrice).toFixed(2)} (${pSize} ${pUnit}) | ตัดใช้ ${pUse} ${pUnit} = ต้นทุน ฿${cost !== '' ? Number(cost).toFixed(2) : '0.00'}` : (isCupMode ? '💡 เลือกวัตถุดิบ ระบบจะคำนวณต้นทุนจาก 1 แก้วให้อัตโนมัติ (แก้ไขตัวเลขได้ตามต้องการ)' : '💡 เลือกวัตถุดิบ ระบบจะคำนวณสัดส่วนจาก 1 แก้วขยายเป็นทั้งโหลให้อัตโนมัติ (แก้ไขตัวเลขได้ตามต้องการ)')}
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

    if (amountInput) {
      amountInput.dataset.prevAmount = amountVal || '';
      amountInput.addEventListener('input', () => {
        amountInput.dataset.prevAmount = amountInput.value;
      });
    }

    toggleBtn.addEventListener('click', () => {
      calcPanel.classList.toggle('show');
      toggleBtn.classList.toggle('active', calcPanel.classList.contains('show'));
    });

    const setFixedUnit = (newUnit) => {
      if (newUnit) {
        amountUnit = newUnit;
        if (amountUnitInput) {
          const optExists = Array.from(amountUnitInput.options).some(o => o.value === newUnit);
          if (!optExists) {
            const newOpt = document.createElement('option');
            newOpt.value = newUnit;
            newOpt.textContent = newUnit;
            amountUnitInput.appendChild(newOpt);
          }
          amountUnitInput.value = newUnit;
        }
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

        badgeText.textContent = `💡 ต้นทุน ฿${price.toFixed(2)} (${size} ${unit}) | ใช้ ${use} ${unit} = ต้นทุน ฿${calculatedCost.toFixed(2)}`;
        badgeText.style.color = 'var(--primary)';
        toggleBtn.classList.add('active');
      } else if (price > 0) {
        badgeText.textContent = `💡 บันทึกราคา ฿${price.toFixed(2)} (${size} ${unit}) ใส่จำนวนที่ใช้เพื่อคำนวณ`;
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
        const expObj = (this.data.expenses || []).find(x => x.id === opt.value);
        const pricing = this.getExpenseUnitPricing(expObj);

        // ถ้าช่องชื่อว่าง ให้กรอกชื่อวัตถุดิบ (ตัดวงเล็บด้านหลังออก)
        if (!nameInput.value.trim()) {
          nameInput.value = title.split('(')[0].trim();
        }

        // กรอกราคาและขนาดต่อหน่วยบรรจุจริง (เช่น ขวดละ 52.50 บาท, 1 kg)
        const unitPrice = pricing ? pricing.calcPrice : (parseFloat(opt.getAttribute('data-unitprice')) || parseFloat(opt.getAttribute('data-amount')) || 0);
        let parsedSize = pricing ? pricing.calcSize : (parseFloat(opt.getAttribute('data-unitsize')) || 1);
        let parsedUnit = pricing ? pricing.calcUnit : (opt.getAttribute('data-unitunit') || 'หน่วย');

        packPriceInput.value = unitPrice;
        packSizeInput.value = parsedSize;
        packUnitInput.value = parsedUnit;
        if (unitLabel) unitLabel.textContent = parsedUnit;

        let autoUse = 0;

        const isCurrentlyCupMode = document.getElementById('recMode')?.value === 'cup';

        // ดึงข้อมูลการชงของ 1 แก้วเพื่อนำมาคำนวณสัดส่วนขยาย
        const jarLiters = parseFloat(document.getElementById('recJarLiters')?.value) || 6;
        const totalYieldCups = parseInt(document.getElementById('recYieldCups')?.value) || 24;
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
          singleCupLiquidMl += 100;
        }
        if (singleCupLiquidMl < 50) singleCupLiquidMl = 250;
        const batchScale = isCurrentlyCupMode ? 1 : totalYieldCups;

        const currentVal = parseFloat(amountInput.value) || 0;
        const currentInputUnit = amountUnitInput?.value || amountUnit || '';

        // หากผู้ใช้มีกรอกปริมาณและเลือกหน่วยไว้แล้วในแถว ให้เคารพค่านั้นและคำนวณ useAmount ตรงๆ
        if (currentVal > 0) {
          syncAmountInputToUseAmount();
        } else if (lowerTitle.includes('แก้ว') || lowerTitle.includes('ฝา') || lowerTitle.includes('หลอด') || parsedUnit.includes('ใบ') || parsedUnit.includes('ชุด')) {
          // บรรจุภัณฑ์ แก้ว/ฝา/หลอด: ใช้ตามจำนวนแก้วที่เสิร์ฟจริง (ถ้า 1 แก้ว คือ 1 ชุด)
          autoUse = isCurrentlyCupMode ? 1 : totalYieldCups;
          amountInput.value = autoUse;
          setFixedUnit('ชุด');
          useAmountInput.value = autoUse || 1;
          runPackCalc();
        } else if (matchedCupAmount > 0 && matchedCupUnit === 'oz') {
          // ถ้ามีสูตร 1 แก้วระบุ oz (เช่น นมสด 1.5 oz, นมข้นหวาน 1 oz, นมข้นจืด 1.5 oz)
          const ozTotal = Math.round((matchedCupAmount * batchScale) * 10) / 10;
          amountInput.value = ozTotal;
          setFixedUnit('oz');

          if (parsedUnit === 'ml' || parsedUnit === 'มล') {
            autoUse = Math.round(ozTotal * 29.57 * 10) / 10;
          } else if (parsedUnit === 'ลิตร' || parsedUnit === 'l' || parsedUnit === 'liter') {
            autoUse = Math.round(((ozTotal * 29.57) / 1000) * 1000) / 1000;
          } else if (parsedUnit.includes('กป') || parsedUnit.includes('กระป๋อง')) {
            autoUse = Math.round((ozTotal / 13) * 100) / 100;
          } else if (parsedUnit === 'g' || parsedUnit === 'กรัม') {
            const gPerOz = (lowerTitle.includes('หวาน') || rowName.includes('หวาน')) ? 38.8 : 31;
            autoUse = Math.round(ozTotal * gPerOz * 10) / 10;
          } else if (parsedUnit === 'kg' || parsedUnit === 'กก') {
            const gPerOz = (lowerTitle.includes('หวาน') || rowName.includes('หวาน')) ? 38.8 : 31;
            autoUse = Math.round(((ozTotal * gPerOz) / 1000) * 1000) / 1000;
          } else {
            autoUse = ozTotal;
          }
          useAmountInput.value = autoUse || 1;
          runPackCalc();
        } else if (matchedCupAmount > 0 && (matchedCupUnit === 'ml' || matchedCupUnit === 'มล')) {
          const mlTotal = Math.round((matchedCupAmount * batchScale) * 10) / 10;
          amountInput.value = mlTotal;
          setFixedUnit('ml');

          if (parsedUnit === 'ml' || parsedUnit === 'มล') {
            autoUse = mlTotal;
          } else if (parsedUnit === 'ลิตร' || parsedUnit === 'l' || parsedUnit === 'liter') {
            autoUse = Math.round((mlTotal / 1000) * 1000) / 1000;
          } else {
            autoUse = mlTotal;
          }
          useAmountInput.value = autoUse || 1;
          runPackCalc();
        } else if (matchedCupAmount > 0 && matchedCupUnit === 'g') {
          // ถ้ามีสูตร 1 แก้วระบุ g (เช่น ผงชาไทย 18g)
          const gTotal = Math.round(matchedCupAmount * batchScale);
          amountInput.value = gTotal;
          setFixedUnit('g');

          if (parsedUnit === 'g' || parsedUnit === 'กรัม') {
            autoUse = gTotal;
          } else if (parsedUnit === 'kg' || parsedUnit === 'กก') {
            autoUse = Math.round((gTotal / 1000) * 1000) / 1000;
          } else if (parsedUnit.includes('ถุง') || parsedUnit.includes('ห่อ') || parsedUnit.includes('แพ็ค') || parsedUnit === 'หน่วย' || parsedUnit === '') {
            const bagSize = (parsedSize > 10 ? parsedSize : 400);
            autoUse = Math.round((gTotal / bagSize) * 1000) / 1000;
          } else {
            autoUse = gTotal;
          }
          useAmountInput.value = autoUse || 1;
          runPackCalc();
        } else if (matchedCupAmount > 0 && matchedCupUnit === 'ลูก') {
          // ถ้าสูตรระบุเป็น 'ลูก' (เช่น ผลไม้สด/ผลไม้แช่แข็ง)
          const pieceTotal = Math.round(matchedCupAmount * (isCurrentlyCupMode ? 1 : totalYieldCups));
          amountInput.value = pieceTotal;
          setFixedUnit('ลูก');
          autoUse = pieceTotal;
          useAmountInput.value = autoUse || 1;
          runPackCalc();
        } else if (matchedCupAmount > 0 && (matchedCupUnit === 'ชิ้น' || matchedCupUnit === 'ชุด')) {
          const pieceTotal = Math.round(matchedCupAmount * (isCurrentlyCupMode ? 1 : totalYieldCups));
          amountInput.value = pieceTotal;
          setFixedUnit(matchedCupUnit);
          autoUse = pieceTotal;
          useAmountInput.value = autoUse || 1;
          runPackCalc();
        } else if (matchedCupAmount > 0 && (matchedCupUnit === 'ช้อนโต๊ะ' || matchedCupUnit === 'tbsp')) {
          const tbspTotal = Math.round((matchedCupAmount * batchScale) * 10) / 10;
          amountInput.value = tbspTotal;
          setFixedUnit('ช้อนโต๊ะ');

          if (parsedUnit === 'ml' || parsedUnit === 'มล') {
            autoUse = Math.round(tbspTotal * 15 * 10) / 10;
          } else if (parsedUnit === 'l' || parsedUnit === 'ลิตร' || parsedUnit === 'liter') {
            autoUse = Math.round(((tbspTotal * 15) / 1000) * 1000) / 1000;
          } else if (parsedUnit === 'g' || parsedUnit === 'กรัม') {
            autoUse = Math.round(tbspTotal * 15 * 10) / 10;
          } else if (parsedUnit === 'kg' || parsedUnit === 'กก') {
            autoUse = Math.round(((tbspTotal * 15) / 1000) * 1000) / 1000;
          } else if (parsedUnit.includes('ถุง') || parsedUnit.includes('ห่อ') || parsedUnit.includes('แพ็ค')) {
            const bagSize = (parsedSize > 10 ? parsedSize : 400);
            autoUse = Math.round(((tbspTotal * 15) / bagSize) * 1000) / 1000;
          } else {
            autoUse = tbspTotal;
          }
          useAmountInput.value = autoUse || 1;
          runPackCalc();
        } else {
          // ถ้าไม่พบการจับคู่กับ 1 แก้วโดยตรง ให้ใช้ fallback ตามชนิดวัตถุดิบ
          if (lowerTitle.includes('นมจืด') || lowerTitle.includes('นมสด') || lowerTitle.includes('เมจิ')) {
            const ozPerBatch = 1.5 * batchScale;
            amountInput.value = ozPerBatch.toFixed(1);
            setFixedUnit('oz');

            if (parsedUnit === 'ml' || parsedUnit === 'มล') {
              autoUse = Math.round(ozPerBatch * 29.57 * 10) / 10;
            } else if (parsedUnit === 'ลิตร' || parsedUnit === 'l' || parsedUnit === 'liter') {
              autoUse = Math.round(((ozPerBatch * 29.57) / 1000) * 1000) / 1000;
            } else if (parsedUnit.includes('กป') || parsedUnit.includes('กระป๋อง')) {
              autoUse = Math.round((ozPerBatch / 13) * 100) / 100;
            } else if (parsedUnit === 'g' || parsedUnit === 'กรัม') {
              autoUse = Math.round(ozPerBatch * 31 * 10) / 10;
            } else if (parsedUnit === 'kg' || parsedUnit === 'กก') {
              autoUse = Math.round(((ozPerBatch * 31) / 1000) * 1000) / 1000;
            } else {
              autoUse = Math.round(ozPerBatch * 10) / 10;
            }
          } else if (lowerTitle.includes('นมข้นหวาน') || lowerTitle.includes('นมหวาน')) {
            const ozPerBatch = 1.0 * batchScale;
            amountInput.value = ozPerBatch.toFixed(1);
            setFixedUnit('oz');

            if (parsedUnit.includes('กป') || parsedUnit.includes('กระป๋อง')) {
              autoUse = Math.round((ozPerBatch / 13) * 100) / 100;
            } else if (parsedUnit === 'g' || parsedUnit === 'กรัม') {
              autoUse = Math.round(ozPerBatch * 38.8 * 10) / 10;
            } else if (parsedUnit === 'kg' || parsedUnit === 'กก') {
              autoUse = Math.round(((ozPerBatch * 38.8) / 1000) * 1000) / 1000;
            } else {
              autoUse = Math.round(ozPerBatch * 10) / 10;
            }
          } else if (lowerTitle.includes('นมข้นจืด') || lowerTitle.includes('คาร์เนชัน')) {
            const ozPerBatch = 1.5 * batchScale;
            amountInput.value = ozPerBatch.toFixed(1);
            setFixedUnit('oz');

            if (parsedUnit.includes('กป') || parsedUnit.includes('กระป๋อง')) {
              autoUse = Math.round((ozPerBatch / 13) * 100) / 100;
            } else if (parsedUnit === 'g' || parsedUnit === 'กรัม') {
              autoUse = Math.round(ozPerBatch * 32 * 10) / 10;
            } else if (parsedUnit === 'kg' || parsedUnit === 'กก') {
              autoUse = Math.round(((ozPerBatch * 32) / 1000) * 1000) / 1000;
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
              autoUse = Math.round((gPerBatch / 1000) * 1000) / 1000;
            } else if (parsedUnit.includes('ถุง') || parsedUnit.includes('ห่อ') || parsedUnit.includes('แพ็ค') || parsedUnit === 'หน่วย' || parsedUnit === '') {
              const bagSize = (parsedSize > 10 ? parsedSize : 400);
              autoUse = Math.round((gPerBatch / bagSize) * 1000) / 1000;
            } else {
              autoUse = gPerBatch;
            }
          } else {
            autoUse = 1;
            amountInput.value = 1;
            setFixedUnit(parsedUnit || 'หน่วย');
          }
          useAmountInput.value = autoUse || 1;
          runPackCalc();
        }
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
          calculatedUse = Math.round(((numVal * 29.57) / 1000) * 1000) / 1000;
        } else if (packUnit.includes('กป') || packUnit.includes('กระป๋อง')) {
          calculatedUse = Math.round((numVal / 13) * 100) / 100;
        } else if (packUnit === 'g' || packUnit === 'กรัม') {
          const gPerOz = lowerRowName.includes('หวาน') ? 38.8 : (lowerRowName.includes('จืด') ? 31 : 30);
          calculatedUse = Math.round(numVal * gPerOz * 10) / 10;
        } else if (packUnit === 'kg' || packUnit === 'กก') {
          const gPerOz = lowerRowName.includes('หวาน') ? 38.8 : (lowerRowName.includes('จืด') ? 31 : 30);
          calculatedUse = Math.round(((numVal * gPerOz) / 1000) * 1000) / 1000;
        } else if (packUnit.includes('ขวด')) {
          calculatedUse = Math.round((numVal / 33.8) * 100) / 100;
        } else {
          calculatedUse = numVal;
        }
      } else if (inputUnit === 'g' || inputUnit === 'กรัม') {
        if (packUnit === 'g' || packUnit === 'กรัม') {
          calculatedUse = numVal;
        } else if (packUnit === 'kg' || packUnit === 'กก') {
          calculatedUse = Math.round((numVal / 1000) * 1000) / 1000;
        } else if (packUnit === 'ml' || packUnit === 'มล') {
          calculatedUse = numVal;
        } else if (packUnit === 'ลิตร' || packUnit === 'l' || packUnit === 'liter') {
          calculatedUse = Math.round((numVal / 1000) * 1000) / 1000;
        } else if (packUnit.includes('ถุง') || packUnit.includes('ห่อ') || packUnit.includes('แพ็ค') || packUnit === 'หน่วย' || packUnit === '') {
          const bagSize = (packSize > 10 ? packSize : 400);
          calculatedUse = Math.round((numVal / bagSize) * 1000) / 1000;
        } else {
          calculatedUse = numVal;
        }
      } else if (inputUnit === 'ml' || inputUnit === 'มล') {
        if (packUnit === 'ml' || packUnit === 'มล') {
          calculatedUse = numVal;
        } else if (packUnit === 'ลิตร' || packUnit === 'l' || packUnit === 'liter') {
          calculatedUse = Math.round((numVal / 1000) * 1000) / 1000;
        } else if (packUnit === 'g' || packUnit === 'กรัม') {
          // ของเหลว/เนื้อผลไม้ 1 ml ~ 1 g
          calculatedUse = numVal;
        } else if (packUnit === 'kg' || packUnit === 'กก') {
          // 1,000 ml = 1 kg (เช่น 320 ml = 0.32 kg)
          calculatedUse = Math.round((numVal / 1000) * 1000) / 1000;
        } else if (packUnit.includes('ถุง') || packUnit.includes('ห่อ') || packUnit.includes('แพ็ค') || packUnit === 'หน่วย' || packUnit === '') {
          // ถ้าซื้อมาเป็นถุง (เช่น ถุงละ 1 kg หรือ ถุงละ 1000 ml)
          const bagSize = (packSize > 10 ? packSize : 1000);
          calculatedUse = Math.round((numVal / bagSize) * 1000) / 1000;
        } else {
          calculatedUse = numVal;
        }
      } else if (inputUnit === 'ช้อนโต๊ะ' || inputUnit === 'tbsp') {
        // 1 ช้อนโต๊ะ ~ 15 ml / ~15g (ผง ~10g, น้ำหวาน/นม ~15-20g)
        if (packUnit === 'ml' || packUnit === 'มล') {
          calculatedUse = Math.round(numVal * 15 * 10) / 10;
        } else if (packUnit === 'l' || packUnit === 'ลิตร' || packUnit === 'liter') {
          calculatedUse = Math.round(((numVal * 15) / 1000) * 1000) / 1000;
        } else if (packUnit === 'g' || packUnit === 'กรัม') {
          calculatedUse = Math.round(numVal * 15 * 10) / 10;
        } else if (packUnit === 'kg' || packUnit === 'กก') {
          calculatedUse = Math.round(((numVal * 15) / 1000) * 1000) / 1000;
        } else if (packUnit.includes('ถุง') || packUnit.includes('ห่อ') || packUnit.includes('แพ็ค')) {
          const bagSize = (packSize > 10 ? packSize : 400);
          calculatedUse = Math.round(((numVal * 15) / bagSize) * 1000) / 1000;
        } else {
          calculatedUse = numVal;
        }
      } else if (inputUnit === 'ลูก' || inputUnit === 'ชิ้น' || inputUnit === 'ชุด') {
        if (packUnit === inputUnit || packUnit === 'ลูก' || packUnit === 'ชิ้น' || packUnit === 'ชุด' || packUnit === 'หน่วย' || packUnit === 'ใบ') {
          calculatedUse = numVal;
        } else if (packUnit.includes('ถุง') || packUnit.includes('ห่อ') || packUnit.includes('แพ็ค') || packUnit.includes('กล่อง') || packUnit.includes('ลัง')) {
          // หากซื้อมาเป็นถุง/แพ็ค โดย packSize คือจำนวนลูก/ชิ้นต่อถุง (เช่น 1 แพ็คมี 10 ลูก)
          const itemsPerPack = packSize > 0 ? packSize : 1;
          calculatedUse = Math.round((numVal / itemsPerPack) * 1000) / 1000;
        } else if (packUnit === 'kg' || packUnit === 'กก') {
          // หากซื้อผลไม้มาเป็น kg: ผลไม้สดทั่วไป 1 ลูก ~ 0.1-0.15 kg (เฉลี่ย 8 ลูก/kg)
          calculatedUse = Math.round((numVal / 8) * 1000) / 1000;
        } else if (packUnit === 'g' || packUnit === 'กรัม') {
          calculatedUse = Math.round(numVal * 125);
        } else {
          calculatedUse = numVal;
        }
      } else if (packUnit.includes('ถุง') || packUnit.includes('ห่อ') || packUnit.includes('แพ็ค')) {
        if (numVal > 10 && packSize > 0) {
          calculatedUse = Math.round((numVal / packSize) * 1000) / 1000;
        }
      }

      if (calculatedUse > 0) {
        useAmountInput.value = calculatedUse;

        // คำนวณต้นทุนทันที (ทั้งโหมด 1 แก้ว และ 1 โหล)
        const price = parseFloat(packPriceInput.value) || 0;
        if (price > 0 && packSize > 0) {
          const calculatedCost = Math.round(((price / packSize) * calculatedUse) * 100) / 100;
          costInput.value = calculatedCost;
          badgeText.textContent = `💡 ต้นทุน ฿${price.toFixed(2)} (${packSize} ${packUnit || 'หน่วย'}) | ใช้ ${calculatedUse} ${packUnit || 'หน่วย'} = ต้นทุน ฿${calculatedCost.toFixed(2)}`;
          badgeText.style.color = 'var(--primary)';
          toggleBtn.classList.add('active');
        }
        this.updateRecipeModalCalculations();
      }
    };

    amountInput.addEventListener('input', syncAmountInputToUseAmount);
    if (amountUnitInput) {
      amountUnitInput.addEventListener('change', () => {
        syncAmountInputToUseAmount();
        this.updateRecipeModalCalculations();
      });
    }
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

  // ปรับสเกลปริมาณและต้นทุนของรายการส่วนผสมต่อโหลโดยตรงตามสัดส่วนลิตรที่เปลี่ยนไป
  scaleBatchIngredientsDirectly(ratio, newYield) {
    if (!ratio || ratio <= 0 || isNaN(ratio)) return;
    const batchRows = document.querySelectorAll('#recipeIngredientsContainer .ingredient-row');
    batchRows.forEach(row => {
      const name = (row.querySelector('.ing-name')?.value || '').trim().toLowerCase();
      const unit = (row.querySelector('.ing-amount-unit')?.value || '').trim();
      const amountInput = row.querySelector('.ing-amount');
      const costInput = row.querySelector('.ing-cost');
      const useAmountInput = row.querySelector('.calc-use-amount');
      const packPriceInput = row.querySelector('.calc-pack-price');
      const packSizeInput = row.querySelector('.calc-pack-size');
      const packUnitInput = row.querySelector('.calc-pack-unit');
      const badgeText = row.querySelector('.calc-badge-text');

      const isPackaging = name.includes('แก้ว') || name.includes('ฝา') || name.includes('หลอด') || unit === 'ชุด' || unit === 'ใบ';

      if (isPackaging && newYield > 0) {
        const prevAmount = parseFloat(amountInput?.dataset?.prevAmount) || parseFloat(amountInput?.value) || newYield;
        const currentCost = parseFloat(costInput?.value) || 0;
        const costPerSet = prevAmount > 0 ? (currentCost / prevAmount) : 1.5;
        const newCost = Math.round(costPerSet * newYield * 100) / 100;
        if (amountInput) {
          amountInput.value = newYield;
          amountInput.dataset.prevAmount = newYield;
        }
        if (costInput) costInput.value = newCost;
        if (useAmountInput) useAmountInput.value = newYield;
      } else {
        if (amountInput && amountInput.value) {
          const curVal = parseFloat(amountInput.value) || 0;
          if (curVal > 0) {
            const scaledVal = Math.round((curVal * ratio) * 10) / 10;
            amountInput.value = scaledVal;
            amountInput.dataset.prevAmount = scaledVal;
          }
        }
        if (useAmountInput && useAmountInput.value) {
          const curUse = parseFloat(useAmountInput.value) || 0;
          if (curUse > 0) {
            const scaledUse = Math.round((curUse * ratio) * 1000) / 1000;
            useAmountInput.value = scaledUse;
          }
        }
        if (costInput && costInput.value) {
          const packPrice = parseFloat(packPriceInput?.value) || 0;
          const packSize = parseFloat(packSizeInput?.value) || 0;
          const useAmount = parseFloat(useAmountInput?.value) || 0;
          if (packPrice > 0 && packSize > 0 && useAmount > 0) {
            const newCost = Math.round(((packPrice / packSize) * useAmount) * 100) / 100;
            costInput.value = newCost;
            if (badgeText) {
              const packUnit = packUnitInput?.value || 'หน่วย';
              badgeText.textContent = `💡 ต้นทุน ฿${Number(packPrice).toFixed(2)} (${packSize} ${packUnit}) | ใช้ ${useAmount} ${packUnit} = ต้นทุน ฿${newCost.toFixed(2)}`;
            }
          } else {
            const curCost = parseFloat(costInput.value) || 0;
            if (curCost > 0) {
              costInput.value = Math.round((curCost * ratio) * 100) / 100;
            }
          }
        }
      }
    });
  }

  updateRecipeModalCalculations() {
    const isCup = document.getElementById('recMode')?.value === 'cup';
    const litersInput = document.getElementById('recJarLiters');
    const jarLiters = isCup ? 0 : (litersInput ? (parseFloat(litersInput.value) || 0) : 6);
    const cupOz = parseInt(document.getElementById('recCupSizeOz')?.value) || 16;
    const yieldCups = isCup ? 1 : (parseInt(document.getElementById('recYieldCups')?.value) || (jarLiters === 5 ? 20 : 24));

    // อัปเดต Label แสดงตามปริมาตรชงต่อโหล/ถัง (ลิตร) ที่ผู้ใช้เลือกจริง
    const jarCostLabel = document.getElementById('modalRecipeJarCostLabel');
    const unitCostLabel = document.getElementById('modalRecipeUnitCostLabel');
    if (jarCostLabel) {
      if (isCup) {
        jarCostLabel.textContent = 'ต้นทุนวัตถุดิบต่อ 1 แก้ว:';
      } else {
        const displayLiters = jarLiters > 0 ? `${jarLiters} ลิตร` : 'โหล/ถัง';
        jarCostLabel.textContent = `ต้นทุนวัตถุดิบต่อ 1 โหล/ถัง (${displayLiters}):`;
      }
    }
    if (unitCostLabel) {
      if (isCup) {
        unitCostLabel.textContent = `ต้นทุนเฉลี่ยต่อแก้ว (${cupOz} oz):`;
      } else {
        unitCostLabel.textContent = `ต้นทุนเฉลี่ยต่อแก้ว (${cupOz} oz, ~${yieldCups} แก้ว):`;
      }
    }

    // ไฮไลต์ปุ่มเลือกปริมาตรด่วนที่ตรงกับค่าปัจจุบัน
    document.querySelectorAll('.btn-liter-preset').forEach(btn => {
      const lit = parseFloat(btn.dataset.liters) || 0;
      if (!isCup && lit > 0 && lit === jarLiters) {
        btn.style.background = 'var(--primary)';
        btn.style.color = '#ffffff';
        btn.style.borderColor = 'var(--primary)';
        btn.style.fontWeight = '700';
      } else {
        btn.style.background = '#ffffff';
        btn.style.color = 'var(--text-main)';
        btn.style.borderColor = 'var(--border-color)';
        btn.style.fontWeight = '500';
      }
    });

    const costInputs = document.querySelectorAll('#recipeIngredientsContainer .ing-cost');
    let totalJarCost = 0;
    costInputs.forEach(input => {
      totalJarCost += parseFloat(input.value) || 0;
    });

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

  // คำนวณสูตรปรับลดสัดส่วนเพื่อให้ได้กำไรต่อแก้วตามเป้าหมาย (กำหนดเองได้)
  calculate5BahtOptimizedRecipe(targetProfit = 5.0) {
    const isCup = document.getElementById('recMode')?.value === 'cup';
    const yieldCups = isCup ? 1 : (parseInt(document.getElementById('recYieldCups')?.value) || 20);
    const priceInput = document.getElementById('recSellingPrice');
    const sellingPrice = priceInput ? (parseFloat(priceInput.value) || 0) : 25;
    const litersInput = document.getElementById('recJarLiters');
    const jarLiters = isCup ? 0 : (litersInput ? (parseFloat(litersInput.value) || 0) : 5);

    // เพดานต้นทุนต่อแก้วเพื่อให้ได้กำไร targetProfit ที่ผู้ใช้กำหนด
    const safeTargetProfit = Math.max(0.1, parseFloat(targetProfit) || 5.0);
    const targetUnitCost = Math.max(0, sellingPrice - safeTargetProfit);
    const targetTotalCost = targetUnitCost * yieldCups;

    const ingredientRows = document.querySelectorAll('#recipeIngredientsContainer .ingredient-row');
    if (ingredientRows.length === 0) {
      return {
        targetProfit: safeTargetProfit,
        sellingPrice,
        yieldCups,
        jarLiters,
        isCup,
        hasData: false,
        items: [],
        currentUnitCost: 0,
        currentProfitPerCup: 0,
        currentTotalCost: 0,
        optimizedUnitCost: 0,
        optimizedProfitPerCup: 0,
        optimizedTotalCost: 0,
        ratio: 1,
        reductionPercent: 0
      };
    }

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

      // กรองเฉพาะแถวที่มีข้อมูลจริง (มีชื่อ หรือมีปริมาณ/ต้นทุน)
      if (!name && amountVal <= 0 && cost <= 0) return;

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

    if (items.length === 0) {
      return {
        targetProfit: safeTargetProfit,
        sellingPrice,
        yieldCups,
        jarLiters,
        isCup,
        hasData: false,
        items: [],
        currentUnitCost: 0,
        currentProfitPerCup: 0,
        currentTotalCost: 0,
        optimizedUnitCost: 0,
        optimizedProfitPerCup: 0,
        optimizedTotalCost: 0,
        ratio: 1,
        reductionPercent: 0
      };
    }

    const currentUnitCost = yieldCups > 0 ? (currentTotalCost / yieldCups) : 0;
    const currentProfitPerCup = sellingPrice - currentUnitCost;

    // คำนวณอัตราส่วนการปรับลด (Reduction Ratio) เฉพาะในส่วนของวัตถุดิบเครื่องดื่ม (ไม่ลดบรรจุภัณฑ์)
    let ratio = 1;
    if (targetTotalCost <= packagingCost) {
      ratio = 0.5;
    } else if (beverageCost > 0) {
      const targetBeverageCost = targetTotalCost - packagingCost;
      ratio = Math.max(0.1, Math.min(1.0, targetBeverageCost / beverageCost));
    } else if (currentTotalCost > 0) {
      ratio = Math.max(0.1, Math.min(1.0, targetTotalCost / currentTotalCost));
    }

    let optimizedTotalCost = 0;
    const optimizedItems = items.map(item => {
      let newAmountVal = item.origAmountVal;
      let newUseAmount = item.origUseAmount;
      let newCost = item.origCost;

      // ถ้าเป็นบรรจุภัณฑ์ หรือ รายการราคา 0 บาท ไม่ต้องปรับสูตร
      if (!item.isPkg && !item.isZeroCost) {
        newAmountVal = Math.round((item.origAmountVal * ratio) * 10) / 10;
        if (item.origAmountVal > 0 && newAmountVal <= 0) newAmountVal = 0.1;

        if (item.origUseAmount > 0) {
          newUseAmount = Math.round((item.origUseAmount * ratio) * 1000) / 1000;
          if (newUseAmount <= 0) newUseAmount = 0.001;
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
      targetProfit: safeTargetProfit,
      sellingPrice,
      yieldCups,
      jarLiters,
      isCup,
      hasData: true,
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

  // ฟังก์ชันแทนที่ค่าในตารางสูตรด้วยสูตรปรับกำไรตามเป้าหมาย (กำหนดเองได้)
  apply5BahtOptimizedRecipe(customTargetProfit = null) {
    let target = customTargetProfit;
    if (target === null || isNaN(target)) {
      const tpInput = document.getElementById('recTargetProfit');
      target = tpInput ? (parseFloat(tpInput.value) || 5.0) : 5.0;
    }
    const opt = this.calculate5BahtOptimizedRecipe(target);
    if (!opt || !opt.items) return;

    // 1. อัปเดตแถวส่วนผสมของโหล (#recipeIngredientsContainer)
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
        badgeText.textContent = `💡 ต้นทุน ฿${Number(item.packPrice).toFixed(2)} (${item.packSize} ${item.packUnit || 'หน่วย'}) | ใช้ ${item.newUseAmount} ${item.packUnit || 'หน่วย'} = ต้นทุน ฿${item.newCost.toFixed(2)} (สูตรปรับกำไร ฿${opt.targetProfit.toFixed(2)})`;
        badgeText.style.color = 'var(--primary)';
      }
    });

    // 2. อัปเดตแถวสัดส่วนต่อ 1 แก้ว (#singleCupContainer) ให้ตรงกันด้วย
    const singleCupRows = document.querySelectorAll('#singleCupContainer .single-cup-row');
    singleCupRows.forEach(cRow => {
      const cName = (cRow.querySelector('.cup-ing-name')?.value || '').toLowerCase().trim();
      const cAmtInp = cRow.querySelector('.cup-ing-amount');
      const cUnit = cRow.querySelector('.cup-ing-unit')?.value || '';
      if (!cAmtInp) return;

      const isPkg = cName.includes('แก้ว') || cName.includes('ฝา') || cName.includes('หลอด') || cUnit === 'ชุด' || cUnit === 'ใบ';
      if (isPkg) return;

      const matchedOpt = opt.items.find(it => {
        const itName = it.name.toLowerCase().trim();
        return itName.includes(cName) || cName.includes(itName) || (cName.includes('ชา') && itName.includes('ชา'));
      });

      if (matchedOpt && isCup) {
        cAmtInp.value = matchedOpt.newAmountVal;
      } else {
        const origVal = parseFloat(cAmtInp.value) || 0;
        if (origVal > 0) {
          cAmtInp.value = Math.round((origVal * opt.ratio) * 10) / 10;
        }
      }
    });

    this.updateRecipeModalCalculations();
    this.showToast(`⚡ ปรับใช้สูตรกำไร ฿${opt.targetProfit.toFixed(2)}/แก้ว (ลดวัตถุดิบ ${opt.reductionPercent}%) เรียบร้อยแล้ว`, 'success');
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

    // ดึงเป้าหมายกำไรต่อแก้วที่ผู้ใช้กำหนดเอง (หากไม่ได้กรอกให้ใช้ค่าเริ่มต้น 5 บาท)
    const targetProfitInput = document.getElementById('recTargetProfit');
    let targetProfit = targetProfitInput ? (parseFloat(targetProfitInput.value) || 5.0) : 5.0;
    if (targetProfit <= 0) targetProfit = 5.0;

    // กรณีพิเศษสำคัญ: หากได้กำไรต่อแก้วน้อยกว่าเป้าหมายที่ผู้ใช้กำหนดเอง
    if (profitPerCup < targetProfit) {
      const opt = this.calculate5BahtOptimizedRecipe(targetProfit);
      const profitDiff = opt ? (opt.optimizedProfitPerCup - profitPerCup) : 0;
      const totalJarProfitDiff = opt ? ((opt.optimizedProfitPerCup * yieldCups) - totalJarProfit) : 0;
      const unitCostDiff = opt ? (unitCost - opt.optimizedUnitCost) : 0;
      const modeLabel = isCup ? 'ต่อ 1 แก้ว' : (opt && opt.jarLiters > 0 ? `ต่อโหล/ถัง ${opt.jarLiters}L` : 'ต่อ 1 โหล/ถัง');
      const hasData = opt && opt.hasData && opt.items && opt.items.length > 0;

      adviceContainer.style.display = 'block';
      adviceContainer.innerHTML = `
        <div class="recipe-5baht-card">
          <!-- Header Badge -->
          <div class="opt-header">
            <div style="flex:1;">
              <div style="display:flex; align-items:center; gap:0.4rem; font-weight:800; color:#c2410c; font-size:0.95rem; line-height:1.35;">
                <span style="font-size:1.15rem; flex-shrink:0;">⚠️</span>
                <span>กำไรต่อแก้วน้อยกว่าเป้าหมาย ฿${targetProfit.toFixed(2)}! <span style="white-space:nowrap;">(ปัจจุบัน ฿${profitPerCup.toFixed(2)}/แก้ว)</span></span>
              </div>
              <div style="font-size:0.8rem; color:#9a3412; margin-top:0.3rem; line-height:1.4;">
                ${hasData ? `ระบบคำนวณปรับลดอัตราส่วนวัตถุดิบลง <strong>${opt.reductionPercent}%</strong> เพื่อให้ได้กำไรตามเป้าหมาย <strong>฿${targetProfit.toFixed(2)}/แก้ว</strong> ตามที่คุณกำหนด (${modeLabel})` : `ระบบรอข้อมูลวัตถุดิบของ <strong>${modeLabel}</strong> เพื่อคำนวณปรับลดอัตราส่วนตามเป้าหมายกำไร ฿${targetProfit.toFixed(2)}/แก้ว`}
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
              <span class="pill-tag" style="background:#ffedd5; color:#c2410c; font-size:0.75rem; font-weight:800; border:1px solid #fdba74; white-space:nowrap;">
                🎯 เป้าหมายกำไร ฿${targetProfit.toFixed(2)}+
              </span>
            </div>
          </div>

          <!-- Custom Target Profit Input Bar in the Card -->
          <div style="background:#fff7ed; border:1.5px solid #fed7aa; border-radius:var(--radius-sm); padding:0.6rem 0.85rem; margin-bottom:0.75rem; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;">
            <div style="display:flex; align-items:center; gap:0.35rem;">
              <span style="font-size:0.85rem; font-weight:700; color:#9a3412;">💰 กำหนดกำไรที่ต้องการต่อแก้ว:</span>
              <span style="font-size:0.75rem; color:#c2410c;">(กรอกตัวเลขกำไรที่ต้องการได้เอง)</span>
            </div>
            <div style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
              <div class="input-with-affix" style="width:110px;">
                <span class="affix-left" style="font-weight:800; color:#ea580c; font-size:0.85rem;">฿</span>
                <input type="number" id="cardTargetProfitInput" class="form-input font-bold" value="${targetProfit}" min="0.5" step="0.5"
                  style="height:34px; padding-left:1.8rem; font-weight:800; color:#c2410c; font-size:0.95rem; background:#ffffff; border-color:#fb923c;">
              </div>
              <span style="font-size:0.8rem; font-weight:700; color:#9a3412;">บาท/แก้ว</span>
              <div style="display:flex; gap:0.25rem;">
                <button type="button" class="btn-preset-profit" data-val="5" style="border:1px solid #fdba74; background:#ffffff; color:#c2410c; font-size:0.75rem; font-weight:700; padding:0.2rem 0.45rem; border-radius:4px; cursor:pointer;">฿5</button>
                <button type="button" class="btn-preset-profit" data-val="7" style="border:1px solid #fdba74; background:#ffffff; color:#c2410c; font-size:0.75rem; font-weight:700; padding:0.2rem 0.45rem; border-radius:4px; cursor:pointer;">฿7</button>
                <button type="button" class="btn-preset-profit" data-val="10" style="border:1px solid #fdba74; background:#ffffff; color:#c2410c; font-size:0.75rem; font-weight:700; padding:0.2rem 0.45rem; border-radius:4px; cursor:pointer;">฿10</button>
              </div>
            </div>
          </div>

          <!-- Overall Comparison Cards -->
          <div class="opt-stats-grid">
            <div class="opt-stat-card card-old">
              <div class="stat-label" style="font-size:0.72rem; color:#78350f; font-weight:600;">สูตรเดิม</div>
              <div class="stat-val" style="font-size:1rem; font-weight:800; color:#dc2626; margin:2px 0;">฿${profitPerCup.toFixed(2)}</div>
              <div class="stat-sub" style="font-size:0.7rem; color:#9ca3af;">${isCup ? `ต้นทุน ฿${unitCost.toFixed(2)}/แก้ว` : `ต้นทุนรวม ฿${totalJarCost.toFixed(2)}`}</div>
            </div>
            <div class="opt-stat-card card-new">
              <div class="stat-label" style="font-size:0.72rem; color:#065f46; font-weight:700;">ปรับกำไร ฿${targetProfit.toFixed(2)}</div>
              <div class="stat-val" style="font-size:1rem; font-weight:800; color:#059669; margin:2px 0;">+฿${(opt ? opt.optimizedProfitPerCup : targetProfit).toFixed(2)}</div>
              <div class="stat-sub" style="font-size:0.7rem; color:#047857;">${isCup ? `ต้นทุน ฿${(opt ? opt.optimizedUnitCost : unitCost).toFixed(2)}/แก้ว` : `ต้นทุนรวม ฿${(opt ? opt.optimizedTotalCost : totalJarCost).toFixed(2)}`}</div>
            </div>
            <div class="opt-stat-card card-diff">
              <div class="stat-label" style="font-size:0.72rem; color:#1e40af; font-weight:600;">กำไรเพิ่ม</div>
              <div class="stat-val" style="font-size:1rem; font-weight:800; color:#2563eb; margin:2px 0;">+฿${profitDiff.toFixed(2)}</div>
              <div class="stat-sub" style="font-size:0.7rem; color:#1d4ed8;">${!isCup ? `(+฿${Math.round(totalJarProfitDiff).toLocaleString()}/ถัง)` : 'ประหยัดขึ้น'}</div>
            </div>
          </div>

          <!-- Detailed Ingredient Comparison Header -->
          <div style="font-size:0.8rem; font-weight:700; color:#7c2d12; margin-bottom:0.45rem; display:flex; justify-content:space-between; align-items:center;">
            <div style="display:flex; align-items:center; gap:0.35rem;">
              <span>📊</span>
              <span>ตารางเปรียบเทียบสัดส่วนปรับลด (${modeLabel}):</span>
            </div>
            <span style="font-size:0.7rem; color:#b45309; font-weight:600;">เป้าหมาย ฿${targetProfit.toFixed(2)}/แก้ว</span>
          </div>

          ${hasData ? `
          <!-- Desktop Table View -->
          <div class="opt-desktop-table opt-table-wrap" style="background:#ffffff; border:1.5px solid #fed7aa; border-radius:var(--radius-sm); overflow-x:auto; margin-bottom:0.85rem; box-shadow:0 1px 4px rgba(0,0,0,0.04);">
            <table style="width:100%; border-collapse:collapse; font-size:0.8rem; text-align:left;">
              <thead>
                <tr style="background:#ffedd5; color:#9a3412; border-bottom:1.5px solid #fed7aa; white-space:nowrap;">
                  <th style="padding:0.5rem 0.65rem; font-weight:700;">วัตถุดิบ</th>
                  <th style="padding:0.5rem 0.65rem; font-weight:700; text-align:center;">
                    สูตรเดิม (${modeLabel})
                  </th>
                  <th style="padding:0.5rem 0.65rem; font-weight:700; text-align:center; color:#065f46;">
                    สูตรกำไร ฿${targetProfit.toFixed(2)} (${modeLabel})
                  </th>
                  <th style="padding:0.5rem 0.65rem; font-weight:700; text-align:right;">ส่วนต่างลดลง</th>
                </tr>
              </thead>
              <tbody>
                ${opt.items.map((item, idx) => {
        const isBgEven = idx % 2 === 0 ? '#ffffff' : '#fffbeb';
        if (item.isZeroCost) {
          return `
                      <tr style="background:${isBgEven}; border-bottom:1px solid #fef3c7;">
                        <td style="padding:0.5rem 0.65rem; font-weight:600; color:#374151;">
                          ${this.escapeHtml(item.name)} <span style="font-size:0.7rem; color:#10b981; font-weight:700;">(ฟรี)</span>
                        </td>
                        <td style="padding:0.5rem 0.65rem; text-align:center; color:#4b5563;">
                          ${item.origAmountVal} ${item.unit}
                        </td>
                        <td style="padding:0.5rem 0.65rem; text-align:center; color:#4b5563;">
                          ${item.newAmountVal} ${item.unit}
                        </td>
                        <td style="padding:0.5rem 0.65rem; text-align:right; color:#10b981; font-size:0.75rem; font-weight:600;">คงเดิม</td>
                      </tr>
                    `;
        }
        if (item.isPkg) {
          return `
                      <tr style="background:${isBgEven}; border-bottom:1px solid #fef3c7;">
                        <td style="padding:0.5rem 0.65rem; font-weight:600; color:#374151;">
                          ${this.escapeHtml(item.name)} <span style="font-size:0.7rem; color:#9ca3af;">(บรรจุภัณฑ์)</span>
                        </td>
                        <td style="padding:0.5rem 0.65rem; text-align:center; color:#4b5563;">
                          ${item.origAmountVal} ${item.unit} <span style="font-size:0.7rem; color:#6b7280;">(฿${item.origCost.toFixed(2)})</span>
                        </td>
                        <td style="padding:0.5rem 0.65rem; text-align:center; color:#4b5563;">
                          ${item.newAmountVal} ${item.unit} <span style="font-size:0.7rem; color:#6b7280;">(฿${item.newCost.toFixed(2)})</span>
                        </td>
                        <td style="padding:0.5rem 0.65rem; text-align:right; color:#9ca3af; font-size:0.75rem;">คงที่</td>
                      </tr>
                    `;
        }
        return `
                    <tr style="background:${isBgEven}; border-bottom:1px solid #fef3c7;">
                      <td style="padding:0.5rem 0.65rem; font-weight:700; color:#1f2937;">
                        ${this.escapeHtml(item.name)}
                      </td>
                      <td style="padding:0.5rem 0.65rem; text-align:center; color:#4b5563;">
                        <div style="font-weight:700; font-size:0.85rem;">${item.origAmountVal} ${item.unit}</div>
                        <div style="font-size:0.7rem; color:#6b7280; margin-top:1px;">(฿${item.origCost.toFixed(2)})</div>
                      </td>
                      <td style="padding:0.5rem 0.65rem; text-align:center; font-weight:700; color:#059669;">
                        <div style="font-weight:800; font-size:0.85rem; color:#059669;">${item.newAmountVal} ${item.unit}</div>
                        <div style="font-size:0.7rem; color:#047857; margin-top:1px;">(฿${item.newCost.toFixed(2)})</div>
                      </td>
                      <td style="padding:0.5rem 0.65rem; text-align:right; font-weight:700; color:#dc2626;">
                        <div>-${item.diffAmount} ${item.unit}</div>
                        <div style="font-size:0.7rem; color:#b91c1c; margin-top:1px;">(-฿${item.diffCost.toFixed(2)})</div>
                      </td>
                    </tr>
                  `;
      }).join('')}
              </tbody>
              <tfoot>
                <tr style="background:#fef3c7; font-weight:800; border-top:2px solid #fed7aa; color:#78350f; white-space:nowrap;">
                  <td style="padding:0.55rem 0.65rem;">ต้นทุนรวม (${modeLabel}):</td>
                  <td style="padding:0.55rem 0.65rem; text-align:center; color:#dc2626;">
                    <div>฿${(isCup ? unitCost : totalJarCost).toFixed(2)}</div>
                  </td>
                  <td style="padding:0.55rem 0.65rem; text-align:center; color:#059669;">
                    <div>฿${(isCup ? opt.optimizedUnitCost : opt.optimizedTotalCost).toFixed(2)}</div>
                  </td>
                  <td style="padding:0.55rem 0.65rem; text-align:right; color:#059669;">
                    <div>ลดลง ฿${(isCup ? unitCostDiff : (totalJarCost - opt.optimizedTotalCost)).toFixed(2)}</div>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <!-- Mobile Cards View -->
          <div class="opt-mobile-list">
            ${opt.items.map((item) => {
        if (item.isZeroCost) {
          return `
                  <div class="opt-mobile-item">
                    <div class="opt-mobile-item-header">
                      <span class="opt-mobile-item-name">${this.escapeHtml(item.name)}</span>
                      <span class="opt-mobile-item-diff diff-fixed">ฟรี (คงเดิม)</span>
                    </div>
                    <div class="opt-mobile-item-body">
                      <div class="opt-mobile-col">
                        <span class="opt-mobile-col-label">สูตรเดิม (${modeLabel})</span>
                        <span class="opt-mobile-col-val">${item.origAmountVal} ${item.unit} (฿0)</span>
                      </div>
                      <div class="opt-mobile-col">
                        <span class="opt-mobile-col-label">สูตรกำไร ฿${targetProfit.toFixed(2)} (${modeLabel})</span>
                        <span class="opt-mobile-col-val val-new">${item.newAmountVal} ${item.unit} (฿0)</span>
                      </div>
                    </div>
                  </div>
                `;
        }
        if (item.isPkg) {
          return `
                  <div class="opt-mobile-item">
                    <div class="opt-mobile-item-header">
                      <span class="opt-mobile-item-name">${this.escapeHtml(item.name)} <span style="font-size:0.7rem; color:#9ca3af; font-weight:normal;">(บรรจุภัณฑ์)</span></span>
                      <span class="opt-mobile-item-diff diff-fixed">คงที่</span>
                    </div>
                    <div class="opt-mobile-item-body">
                      <div class="opt-mobile-col">
                        <span class="opt-mobile-col-label">สูตรเดิม (${modeLabel})</span>
                        <span class="opt-mobile-col-val">${item.origAmountVal} ${item.unit} (฿${item.origCost.toFixed(2)})</span>
                      </div>
                      <div class="opt-mobile-col">
                        <span class="opt-mobile-col-label">สูตรกำไร ฿${targetProfit.toFixed(2)} (${modeLabel})</span>
                        <span class="opt-mobile-col-val val-new">${item.newAmountVal} ${item.unit} (฿${item.newCost.toFixed(2)})</span>
                      </div>
                    </div>
                  </div>
                `;
        }
        return `
                <div class="opt-mobile-item">
                  <div class="opt-mobile-item-header">
                    <span class="opt-mobile-item-name">${this.escapeHtml(item.name)}</span>
                    <span class="opt-mobile-item-diff diff-reduced">ลด -${item.diffAmount} ${item.unit} (-฿${item.diffCost.toFixed(2)})</span>
                  </div>
                  <div class="opt-mobile-item-body">
                    <div class="opt-mobile-col">
                      <span class="opt-mobile-col-label">สูตรเดิม (${modeLabel})</span>
                      <span class="opt-mobile-col-val" style="color:#6b7280;">${item.origAmountVal} ${item.unit} <span style="font-size:0.72rem;">(฿${item.origCost.toFixed(2)})</span></span>
                    </div>
                    <div class="opt-mobile-col">
                      <span class="opt-mobile-col-label" style="color:#047857;">สูตรใหม่ (${modeLabel})</span>
                      <span class="opt-mobile-col-val val-new">${item.newAmountVal} ${item.unit} <span style="font-size:0.72rem; color:#047857;">(฿${item.newCost.toFixed(2)})</span></span>
                    </div>
                  </div>
                </div>
              `;
      }).join('')}

            <!-- Mobile Summary Card -->
            <div class="opt-mobile-summary-card">
              <div>
                <div style="font-weight:700; color:#78350f;">ต้นทุนรวม (${modeLabel})</div>
                <div style="font-size:0.72rem; color:#b45309;">เดิม ฿${(isCup ? unitCost : totalJarCost).toFixed(2)} ➔ ใหม่ ฿${(isCup ? opt.optimizedUnitCost : opt.optimizedTotalCost).toFixed(2)}</div>
              </div>
              <div style="text-align:right;">
                <span class="badge-pill-item green-tag" style="font-size:0.8rem; font-weight:800; padding:0.25rem 0.55rem;">
                  ลดลง ฿${(isCup ? unitCostDiff : (totalJarCost - opt.optimizedTotalCost)).toFixed(2)}
                </span>
              </div>
            </div>
          </div>
          ` : `
          <!-- Empty State Notice when no ingredients found in the selected mode -->
          <div style="background:#f8fafc; border:1.5px dashed #cbd5e1; border-radius:var(--radius-sm); padding:1.75rem 1rem; text-align:center; margin-bottom:0.85rem;">
            <div style="font-size:1.8rem; margin-bottom:0.35rem;">📋</div>
            <div style="font-weight:700; color:#475569; font-size:0.9rem;">
              ไม่มีข้อมูลสูตรในรูปแบบที่เลือก (${modeLabel})
            </div>
            <div style="font-size:0.78rem; color:#94a3b8; margin-top:0.3rem;">
              ไม่พบรายการส่วนผสมของ${modeLabel} กรุณากรอกรายการวัตถุดิบและปริมาณในสูตรเพื่อคำนวณสัดส่วนปรับลด
            </div>
          </div>
          `}

          <!-- Action Buttons -->
          <div class="opt-footer-actions" style="display:flex; justify-content:space-between; gap:0.5rem; align-items:center;">
            <span style="font-size:0.75rem; color:#9a3412;">
              ${hasData ? '💡 กดปุ่มเพื่ออัปเดตสัดส่วนลงในสูตรทันที' : '💡 กรอกส่วนผสมเพื่อคำนวณและปรับใช้สูตร'}
            </span>
            <button type="button" id="btnApplyOptimizedTargetProfit" class="btn-fastwork-sm opt-btn-apply"
              ${hasData ? '' : 'disabled'}
              style="background:${hasData ? '#059669' : '#9ca3af'}; border-color:${hasData ? '#047857' : '#9ca3af'}; color:#ffffff; font-weight:700; padding:0.48rem 0.95rem; box-shadow:${hasData ? '0 2px 6px rgba(5,150,105,0.25)' : 'none'}; display:inline-flex; align-items:center; gap:0.35rem; cursor:${hasData ? 'pointer' : 'not-allowed'}; opacity:${hasData ? '1' : '0.6'};">
              <span>⚡ ปรับใช้สูตรกำไร ฿${targetProfit.toFixed(2)} ทันที</span>
            </button>
          </div>
        </div>
      `;

      const btnApply = document.getElementById('btnApplyOptimizedTargetProfit');
      if (btnApply) {
        btnApply.onclick = () => {
          this.apply5BahtOptimizedRecipe(targetProfit);
        };
      }

      const cardInput = document.getElementById('cardTargetProfitInput');
      if (cardInput) {
        cardInput.addEventListener('change', (e) => {
          const val = parseFloat(e.target.value) || 0;
          if (val > 0) {
            const fInput = document.getElementById('recTargetProfit');
            if (fInput) fInput.value = val;
            this.updateRecipeModalCalculations();
          }
        });
      }

      document.querySelectorAll('.btn-preset-profit').forEach(btn => {
        btn.addEventListener('click', () => {
          const val = parseFloat(btn.dataset.val) || 5;
          const fInput = document.getElementById('recTargetProfit');
          if (fInput) fInput.value = val;
          this.updateRecipeModalCalculations();
        });
      });

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
      const isCrate = packUnit.includes('ลัง') || packUnit.includes('แพ็ค') || packUnit.includes('กล่อง') ||
        packUnit.toLowerCase() === 'crate' || packUnit.toLowerCase() === 'pack' || packUnit.toLowerCase() === 'box';
      const crateBottles = isCrate ? (!isNaN(crateBottlesVal) && crateBottlesVal > 0 ? crateBottlesVal : 12) : null;
      const supplier = document.getElementById('expSupplier')?.value.trim() || '';
      const note = document.getElementById('expNote')?.value.trim() || '';

      const netWeightParsed = parseFloat(document.getElementById('expNetWeight')?.value);
      const netWeight = (!isNaN(netWeightParsed) && netWeightParsed > 0) ? netWeightParsed : null;
      const netUnit = netWeight ? (document.getElementById('expNetUnit')?.value || 'g') : null;

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
        netWeight,
        netUnit,
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
        const pricing = this.getExpenseUnitPricing(newExp);
        const syncDesc = (pricing && pricing.isBulk && pricing.itemsPerBulk > 1)
          ? `+${pricing.rawPackSize} ${pricing.rawUnit} = ${pricing.rawPackSize * pricing.itemsPerBulk} ${pricing.pieceName}`
          : `+${newExp.packSize} ${newExp.packUnit}`;
        this.showToast(`บันทึกรายจ่าย & เติมเข้าสต๊อก "${title}" (${syncDesc}) เรียบร้อย!`, 'success');
      }

      this.saveData();
      this.syncRecipesWithExpenses();
      const expModal = document.getElementById('expenseModal');
      if (expModal) expModal.classList.remove('active');

      this.renderExpenses();
      this.renderRecipes();
      this.renderStock();
      this.renderStockHistory();
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
    if (recipeForm && !recipeForm._boundSubmit) {
      recipeForm._boundSubmit = true;
      recipeForm.addEventListener('submit', (e) => {
        e.preventDefault();

        if (this._isSavingRecipe) return;
        this._isSavingRecipe = true;

        const editId = document.getElementById('recipeEditId')?.value || '';
        const name = (document.getElementById('recName')?.value || '').trim();
        if (!name) {
          this._isSavingRecipe = false;
          this.showToast('กรุณากรอกชื่อเมนูเครื่องดื่ม', 'warning');
          document.getElementById('recName')?.focus();
          return;
        }

        const mode = document.getElementById('recMode')?.value || 'jar';
        const isCup = mode === 'cup';
        const jarLiters = isCup ? 0 : (parseFloat(document.getElementById('recJarLiters')?.value) || 6);
        const cupSizeOz = parseInt(document.getElementById('recCupSizeOz')?.value) || 16;
        const yieldCups = isCup ? 1 : (parseInt(document.getElementById('recYieldCups')?.value) || 24);
        const jarCapacity = isCup ? `แก้ว ${cupSizeOz} oz (1 แก้ว)` : (document.getElementById('recJarCapacity')?.value.trim() || `โหล/ถัง ${jarLiters} ลิตร (${yieldCups} แก้ว)`);
        const instructions = document.getElementById('recInstructions')?.value.trim() || '';

        const ingRows = document.querySelectorAll('#recipeIngredientsContainer .ingredient-row');
        const ingredients = [];
        ingRows.forEach(row => {
          const iName = row.querySelector('.ing-name')?.value.trim() || '';
          const iAmountNum = row.querySelector('.ing-amount')?.value.trim() || '';
          const iAmountUnit = (row.querySelector('.ing-amount-unit')?.value || '').trim();
          const iAmount = iAmountNum ? `${iAmountNum} ${iAmountUnit}`.trim() : '';
          const iCost = parseFloat(row.querySelector('.ing-cost')?.value) || 0;

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
        const targetProfit = parseFloat(document.getElementById('recTargetProfit')?.value) || 5;

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
          targetProfit,
          yieldCups,
          sellingPrice,
          suggestedPrice,
          jarCapacity,
          instructions,
          ingredients,
          singleCupProportions
        };

        if (!this.data.recipes) {
          this.data.recipes = [];
        }

        if (editId) {
          const idx = this.data.recipes.findIndex(r => r.id === editId);
          if (idx !== -1) {
            this.data.recipes[idx] = { ...recipeRecord, id: editId };
          } else {
            this.data.recipes.unshift({ ...recipeRecord, id: editId });
          }
          this.showToast('แก้ไขสูตรชงน้ำเรียบร้อยแล้ว', 'success');
        } else {
          const newRec = { ...recipeRecord, id: 'r_' + Date.now() };
          this.data.recipes.unshift(newRec);
          this.showToast('บันทึกสูตรชงน้ำใหม่เรียบร้อยแล้ว', 'success');
        }

        this.saveData();
        const recModal = document.getElementById('recipeModal');
        if (recModal) recModal.classList.remove('active');
        this.renderRecipes();

        setTimeout(() => {
          this._isSavingRecipe = false;
        }, 300);
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

    const stockUseProfitForm = document.getElementById('stockUseProfitForm');
    if (stockUseProfitForm) {
      stockUseProfitForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleStockUseProfitSubmit();
      });
    }

    const quickRestockForm = document.getElementById('quickRestockForm');
    if (quickRestockForm) {
      quickRestockForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleQuickRestockSubmit();
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
    let outOfStockCount = 0;
    let totalValue = 0;

    list.forEach(item => {
      const qty = Number(item.qty) || 0;
      const minQty = Number(item.minQty) || 0;
      const isOutOfStock = qty <= 0;
      const isLow = (minQty > 0 && qty <= minQty) || isOutOfStock;

      if (isOutOfStock) {
        outOfStockCount++;
      }
      if (isLow) {
        lowCount++;
      } else if (minQty === 0) {
        noAlertCount++;
      } else {
        normalCount++;
      }

      if (qty > 0) {
        totalValue += qty * (Number(item.unitCost) || 0);
      }
    });

    // แยกรายการสินค้า:
    // รายการที่มีสต๊อก (> 0) แสดงในหน้านี้
    // รายการที่สต๊อกหมด (<= 0) ย้ายไปแสดงที่หน้า "สินค้าใกล้หมด (เตือนซื้อ)" แทน
    const activeList = list.filter(item => (Number(item.qty) || 0) > 0);
    const outOfStockList = list.filter(item => (Number(item.qty) || 0) <= 0);

    // Update Out of Stock Notice Banner
    const outOfStockBanner = document.getElementById('stockOutOfStockNoticeBanner');
    const outOfStockTitle = document.getElementById('stockOutOfStockBannerTitle');
    if (outOfStockBanner) {
      if (outOfStockList.length > 0) {
        outOfStockBanner.style.display = 'flex';
        if (outOfStockTitle) {
          outOfStockTitle.textContent = `มีสินค้าหมดสต๊อก (${outOfStockList.length} รายการ)`;
        }
      } else {
        outOfStockBanner.style.display = 'none';
      }
    }

    // Update KPI Cards
    const kpiLow = document.getElementById('kpiStockLowCount');
    const kpiTotal = document.getElementById('kpiStockTotalItems');
    const kpiNormal = document.getElementById('kpiStockNormalCount');
    const kpiValue = document.getElementById('kpiStockTotalValue');
    const kpiLowSub = document.getElementById('kpiStockLowSubtext');
    const kpiTotalSub = document.getElementById('kpiStockTotalSubtext');

    if (kpiLow) kpiLow.textContent = `${lowCount} รายการ`;
    if (kpiLowSub) kpiLowSub.textContent = outOfStockCount > 0 ? `หมดสต๊อก ${outOfStockCount} | ใกล้หมด ${lowCount - outOfStockCount}` : 'คลิกเพื่อไปหน้าสั่งซื้อด่วน';
    if (kpiTotal) kpiTotal.textContent = `${activeList.length} รายการ`;
    if (kpiTotalSub) kpiTotalSub.textContent = outOfStockCount > 0 ? `ย้ายไปหน้าเตือนซื้อ ${outOfStockCount} รายการ` : 'มีสต๊อกพร้อมชงขาย';
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
    if (tabFilterAllText) tabFilterAllText.textContent = `มีสต๊อก (${activeList.length})`;
    if (tabFilterLowText) tabFilterLowText.textContent = `⚠️ เตือนซื้อ (${lowCount})`;

    // อัปเดตสรุปยอดจ่ายรวมแยกตามหมวดหมู่ในหน้าสต๊อก
    this.renderStockExpenseSummary();

    // Render Daily Stock Profit Card
    this.renderStockProfitCard();

    if (activeList.length === 0) {
      if (list.length > 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="8" class="text-center py-4 text-muted">
              สินค้าในร้านหมดสต๊อกทุกรายการ (ทั้งหมด ${list.length} รายการ ถูกย้ายไปแสดงที่หน้า 
              <a href="javascript:void(0)" onclick="app.switchTab('stock-low')" style="font-weight:700; color:var(--danger); text-decoration:underline;">
                🚨 สินค้าใกล้หมด (เตือนซื้อ)
              </a> เพื่อจัดซื้อเติมของ)
            </td>
          </tr>
        `;
      } else {
        tbody.innerHTML = `
          <tr>
            <td colspan="8" class="text-center py-4 text-muted">
              ยังไม่มีสินค้าในสต๊อก กดปุ่ม <b>"+ เพิ่มสินค้าใหม่เข้าสต๊อก"</b> หรือ <b>"ซิงค์จากบิลซื้อของ"</b>
            </td>
          </tr>
        `;
      }
      this.refreshLucide();
      return;
    }

    // Sort according to stockSortOrder (default: newest) among active stock items
    const stockSortEl = document.getElementById('stockSortOrder');
    const stockSort = stockSortEl?.dataset?.order || stockSortEl?.value || 'newest';
    const sorted = [...activeList].sort((a, b) => {
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

      const crateBottles = Number(item.crateBottles) || 0;
      const isBulk = crateBottles > 1;
      const rawUnit = item.rawUnit || 'ลัง';

      const catLabel = item.category === 'INGREDIENT' ? 'วัตถุดิบชง'
        : item.category === 'PACKAGING' ? 'บรรจุภัณฑ์'
          : item.category === 'FRIDGE_DRINK' ? 'น้ำขายในตู้'
            : item.category === 'STOCK' ? 'สำเร็จรูป/ลัง' : 'อื่นๆ';
      const catClass = item.category === 'INGREDIENT' ? 'blue-tag'
        : item.category === 'PACKAGING' ? 'orange-tag'
          : item.category === 'FRIDGE_DRINK' ? 'cyan-tag'
            : item.category === 'STOCK' ? 'purple-tag' : 'gray-tag';
      const catIcon = item.category === 'INGREDIENT' ? 'coffee'
        : item.category === 'PACKAGING' ? 'cup-soda'
          : item.category === 'FRIDGE_DRINK' ? 'snowflake'
            : item.category === 'STOCK' ? 'package' : 'archive';

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
                  ${isBulk ? `<span class="pill-tag blue-tag" style="font-size:0.7rem; padding:0.1rem 0.45rem; font-weight:700;">📦 บรรจุ ${crateBottles} ${this.escapeHtml(unit)}/${this.escapeHtml(rawUnit)}</span>` : ''}
                  ${item.netWeight ? `<span class="pill-tag" style="font-size:0.7rem; padding:0.1rem 0.45rem; background:#f1f5f9; color:#475569;">⚖️ ${item.netWeight} ${this.escapeHtml(item.netUnit || 'g')}</span>` : ''}
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
            <div class="font-bold text-main" style="font-size:0.9rem;">${this.formatCurrency(unitCost)}</div>
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

    this.applyStockFilter();
    this.refreshLucide();
  }

  // อัปเดตสรุปยอดจ่ายรวมแยกตามหมวดหมู่สินค้าในหน้าสต๊อก
  renderStockExpenseSummary() {
    const expenses = this.data.expenses || [];
    const totalAll = expenses.reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catIng = expenses.filter(e => e.category === 'INGREDIENT').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catPack = expenses.filter(e => e.category === 'PACKAGING').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catStock = expenses.filter(e => e.category === 'STOCK').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catFridge = expenses.filter(e => e.category === 'FRIDGE_DRINK').reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const catOther = expenses.filter(e => e.category === 'OTHER').reduce((a, b) => a + (Number(b.amount) || 0), 0);

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('stockExpCategoryTotal', this.formatCurrency(totalAll));
    setEl('stockExpTotalCount', `${expenses.length} รายการ`);
    setEl('stockExpCatIngredients', this.formatCurrency(catIng));
    setEl('stockExpCatPackaging', this.formatCurrency(catPack));
    setEl('stockExpCatStock', this.formatCurrency(catStock));
    setEl('stockExpCatFridgeDrink', this.formatCurrency(catFridge));
    setEl('stockExpCatOther', this.formatCurrency(catOther));
  }

  setStockFilter(type) {
    this.currentStockFilter = type || 'all';

    // Synchronize radio tabs
    document.querySelectorAll('input[name="stockSubFilter"]').forEach(radio => {
      radio.checked = (radio.value === this.currentStockFilter);
    });

    this.applyStockFilter();
  }

  applyStockFilter() {
    const filterVal = this.currentStockFilter || 'all';
    const searchInput = document.getElementById('stockSearchInput');
    const query = (searchInput?.value || '').toLowerCase().trim();
    const rows = document.querySelectorAll('#stockTableBody tr:not(.stock-empty-row)');
    let visibleCount = 0;

    rows.forEach(tr => {
      const cat = tr.dataset.category;
      const isLow = tr.dataset.isLow === 'true';
      const text = (tr.textContent || tr.innerText || '').toLowerCase();

      let matchFilter = true;
      if (filterVal === 'low') {
        matchFilter = isLow;
      } else if (filterVal === 'normal') {
        matchFilter = !isLow;
      } else if (filterVal !== 'all') {
        matchFilter = (cat === filterVal);
      }

      let matchSearch = true;
      if (query) {
        matchSearch = text.includes(query);
      }

      if (matchFilter && matchSearch) {
        tr.classList.remove('stock-row-hidden');
        tr.style.display = '';
        visibleCount++;
      } else {
        tr.classList.add('stock-row-hidden');
        tr.style.display = 'none';
      }
    });

    const tbody = document.getElementById('stockTableBody');
    if (!tbody) return;

    let emptyRow = document.getElementById('stockFilterEmptyRow');
    if (visibleCount === 0 && rows.length > 0) {
      if (!emptyRow) {
        emptyRow = document.createElement('tr');
        emptyRow.id = 'stockFilterEmptyRow';
        emptyRow.className = 'stock-empty-row';
        tbody.appendChild(emptyRow);
      }
      emptyRow.innerHTML = `
        <td colspan="8" class="text-center py-4 text-muted" style="padding:2.5rem 1rem !important;">
          <div style="display:inline-flex; align-items:center; justify-content:center; width:44px; height:44px; border-radius:50%; background:#f1f5f9; color:#94a3b8; margin-bottom:0.5rem;">
            <i data-lucide="package-search" style="width:24px;height:24px;"></i>
          </div>
          <div class="font-bold text-main" style="font-size:0.95rem;">ไม่พบรายการสินค้าที่ตรงกับเงื่อนไข</div>
          <div class="text-xs text-muted" style="margin-top:0.25rem;">ลองเปลี่ยนตัวกรอง หรือค้นหาด้วยชื่ออื่น</div>
        </td>
      `;
      emptyRow.style.display = '';
      this.refreshLucide();
    } else if (emptyRow) {
      emptyRow.style.display = 'none';
    }
  }

  logStockAction(itemName, actionType, changeQty, currentQty, unit, note = '', extra = {}) {
    if (!Array.isArray(this.data.stockLogs)) {
      this.data.stockLogs = [];
    }

    const now = new Date();
    const timeStr = (extra && extra.time) ? extra.time : `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dateStr = (extra && extra.date) ? String(extra.date).substring(0, 10) : this.formatDate(now);

    const logEntry = {
      id: 'log_' + Date.now() + Math.random().toString(36).substring(2, 5),
      date: dateStr,
      time: timeStr,
      timestamp: Date.now(),
      itemId: extra.itemId || null,
      itemName: itemName,
      actionType: actionType, // 'USE' (เบิก/ตัดสต๊อก), 'RESTOCK' (เติมสต๊อก), 'DIRECT_SET' (แก้ไขโดยตรง)
      changeQty: changeQty,
      resultingQty: currentQty,
      unit: unit,
      note: note,
      profit: extra.profit !== undefined ? extra.profit : null,
      revenue: extra.revenue !== undefined ? extra.revenue : null,
      cost: extra.cost !== undefined ? extra.cost : null,
      sellingPrice: extra.sellingPrice !== undefined ? extra.sellingPrice : null,
      unitCost: extra.unitCost !== undefined ? extra.unitCost : null,
      isStockSale: Boolean(extra.isStockSale),
      expenseId: extra.expenseId || null,
      prevUnitCost: extra.prevUnitCost !== undefined ? extra.prevUnitCost : null,
      isReversal: Boolean(extra.isReversal)
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
    const lowerName = (item.name || '').toLowerCase();
    const isPackaging = item.category === 'PACKAGING' || lowerName.includes('แก้ว') || lowerName.includes('ฝา') || lowerName.includes('หลอด') || lowerName.includes('ถุงแก้ว') || lowerName.includes('ถุงหิ้ว');
    const isIngredient = item.category === 'INGREDIENT';
    const isOther = item.category === 'OTHER';

    // ตรวจสอบว่าสินค้านี้ถูกใช้เป็นวัตถุดิบ/บรรจุภัณฑ์ใน "แพ็คขาย" หรือไม่ (ถ้าใช่ ห้ามนำมาคิดกำไรซ้ำ)
    const isUsedInPackSell = this.isItemUsedAsPackSellRawMaterial(item);

    // คำนวณกำไรเฉพาะ น้ำขายในตู้ (FRIDGE_DRINK) และ ของแพ็คขาย (PACK_SELL) หรือ สำเร็จรูป (STOCK) เท่านั้น
    // ส่วน บรรจุภัณฑ์ (PACKAGING), วัตถุดิบ (INGREDIENT), อื่นๆ และสินค้าที่ถูกใช้เป็นวัตถุดิบในแพ็คขาย จะไม่นำมาคิดกำไร
    const isSellable = !isPackaging && !isIngredient && !isOther && !isUsedInPackSell &&
      (item.category === 'FRIDGE_DRINK' || item.category === 'PACK_SELL' || item.category === 'STOCK');
    const useQty = Math.abs(diff);
    const unitCost = Number(item.unitCost) || 0;
    let sellPrice = Number(item.sellingPrice) || 0;
    let saleProfitRecorded = null;

    if (diff < 0 && isSellable) {
      // คำนวณราคาขายอัตโนมัติทันทีหากยังไม่ได้ตั้งราคา โดยไม่เด้ง alert ใดๆ รบกวนผู้ใช้
      if (sellPrice <= 0 && unitCost > 0) {
        sellPrice = Math.round(unitCost * 1.3);
        item.sellingPrice = sellPrice;
      }

      const isBulk = (Number(item.crateBottles) > 1);
      const crateBottles = Number(item.crateBottles) || 1;
      const rawUnit = item.rawUnit || 'ลัง';
      const crateSub = isBulk ? ` (~${(useQty / crateBottles).toFixed(2).replace(/\.?0+$/, '')} ${rawUnit})` : '';

      if (sellPrice > 0) {
        const totalRevenue = parseFloat((useQty * sellPrice).toFixed(2));
        const totalCost = parseFloat((useQty * unitCost).toFixed(2));
        const totalProfit = parseFloat((totalRevenue - totalCost).toFixed(2));
        const profitStr = totalProfit >= 0 ? `+฿${totalProfit.toFixed(2)}` : `-฿${Math.abs(totalProfit).toFixed(2)}`;
        const logNote = `เบิกขาย ${useQty} ${item.unit || 'หน่วย'}${crateSub} (@฿${sellPrice.toFixed(2)} ทุน ฿${this.formatUnitCost(unitCost)}) กำไร ${profitStr} [ปรับสต๊อกเป็น ${parsed}]`;

        this.logStockAction(item.name, 'USE', diff, parsed, item.unit || '', logNote, {
          itemId: item.id,
          profit: totalProfit,
          revenue: totalRevenue,
          cost: totalCost,
          sellingPrice: sellPrice,
          unitCost: unitCost,
          isStockSale: true,
          category: item.category || 'STOCK'
        });

        // บันทึกเข้า Daily Sales (ยอดขายประจำวัน) อัตโนมัติทันที
        const todayStr = this.formatDate(new Date());
        if (!Array.isArray(this.data.dailySales)) this.data.dailySales = [];
        const existingIndex = this.data.dailySales.findIndex(d => d.date === todayStr);
        const saleDesc = `ขาย ${item.name} x${useQty} ${item.unit || 'หน่วย'} (กำไร ${profitStr})`;
        if (existingIndex !== -1) {
          const ex = this.data.dailySales[existingIndex];
          ex.revenue = parseFloat(((Number(ex.revenue) || 0) + totalRevenue).toFixed(2));
          ex.cost = parseFloat(((Number(ex.cost) || 0) + totalCost).toFixed(2));
          ex.materialCost = parseFloat(((Number(ex.materialCost) || 0) + totalCost).toFixed(2));
          ex.profit = parseFloat(((Number(ex.profit) || 0) + totalProfit).toFixed(2));
          ex.note = ex.note ? `${ex.note}, ${saleDesc}` : saleDesc;
        } else {
          const costInfo = this.getSystemCostForDate(todayStr, totalRevenue);
          const dailyRent = costInfo.dailyRent || 0;
          const newRecord = {
            id: 'd_' + Date.now(),
            date: todayStr,
            revenue: totalRevenue,
            cost: parseFloat((totalCost + dailyRent).toFixed(2)),
            materialCost: totalCost,
            dailyRent: dailyRent,
            profit: parseFloat((totalRevenue - totalCost - dailyRent).toFixed(2)),
            note: saleDesc
          };
          this.data.dailySales.unshift(newRecord);
        }

        saleProfitRecorded = totalProfit;
      } else {
        this.logStockAction(item.name, 'USE', diff, parsed, item.unit || '', `พิมพ์ปรับจำนวนจาก ${oldQty} เป็น ${parsed}${crateSub}`);
      }
    } else {
      const isBulk = (Number(item.crateBottles) > 1);
      const crateBottles = Number(item.crateBottles) || 1;
      const rawUnit = item.rawUnit || 'ลัง';
      const crateSub = isBulk ? ` (~${(parsed / crateBottles).toFixed(2).replace(/\.?0+$/, '')} ${rawUnit})` : '';
      this.logStockAction(item.name, actionType, diff, parsed, item.unit || '', `พิมพ์ปรับจำนวนจาก ${oldQty} เป็น ${parsed} ${item.unit || ''}${crateSub}`);
    }

    // ถ้าพิมพ์เพิ่มจำนวน (diff > 0) ให้สร้างบิลรายจ่ายของเดือนปัจจุบันอัตโนมัติ (จำนวนที่เพิ่ม × ต้นทุนต่อหน่วย)
    if (diff > 0 && (Number(item.unitCost) || 0) > 0) {
      if (!Array.isArray(this.data.expenses)) this.data.expenses = [];
      const expenseAmount = parseFloat((diff * item.unitCost).toFixed(2));
      const todayStr = this.formatDate(new Date());
      const isBulk = (Number(item.crateBottles) > 1);
      const crateBottles = Number(item.crateBottles) || 1;
      const rawUnit = item.rawUnit || 'ลัง';
      const newExp = {
        id: 'e_' + Date.now() + Math.random().toString(36).substring(2, 5),
        date: todayStr,
        title: item.name,
        category: item.category || 'INGREDIENT',
        amount: expenseAmount,
        qtyDesc: isBulk
          ? `${diff} ${item.unit || 'หน่วย'} (~${(diff / crateBottles).toFixed(2).replace(/\.?0+$/, '')} ${rawUnit}) @ ฿${item.unitCost}/${item.unit || 'หน่วย'}`
          : `${diff} ${item.unit || 'หน่วย'} (ราคา ฿${item.unitCost}/${item.unit || 'หน่วย'})`,
        packSize: isBulk ? parseFloat((diff / crateBottles).toFixed(2)) : diff,
        packUnit: isBulk ? rawUnit : (item.unit || 'หน่วย'),
        crateBottles: isBulk ? crateBottles : null,
        minQty: item.minQty,
        supplier: item.supplier || '',
        note: `พิมพ์เติมสต๊อก (+${diff} ${item.unit || ''}): ลงรายจ่ายอัตโนมัติ`,
        stockItemId: item.id
      };
      this.data.expenses.unshift(newExp);
    }

    this.saveData();
    this.syncRecipesWithExpenses();
    this.renderStock();
    this.renderStockProfitCard();
    this.renderStockHistory();
    this.renderLowStockAlertView();
    this.renderExpenses();
    this.renderRecipes();
    this.calculatePricing();
    this.renderDashboard();
    this.renderTodaySummary();
    this.renderCalendar();

    if (diff > 0 && (Number(item.unitCost) || 0) > 0) {
      const expVal = (diff * item.unitCost).toFixed(2);
      this.showToast(`ปรับยอด "${item.name}" เป็น ${parsed} ${item.unit || ''} (ลงต้นทุนรายจ่ายเดือนนี้ ฿${this.formatCurrency(expVal)} อัตโนมัติ)`, 'success');
    } else if (saleProfitRecorded !== null) {
      this.showToast(`✅ เบิกขาย "${item.name}" ${useQty} ${item.unit || 'หน่วย'} สำเร็จ! ได้กำไร ${saleProfitRecorded >= 0 ? '+' : ''}${this.formatCurrency(saleProfitRecorded)} (คงเหลือ ${parsed})`, 'success');
    } else {
      this.showToast(`ปรับยอดคงเหลือ "${item.name}" เป็น ${parsed} ${item.unit || ''} (บันทึกประวัติแล้ว)`, 'success');
    }
  }

  adjustStockQty(itemId, delta) {
    if (delta > 0) {
      // เมื่อกดปุ่ม + ให้เปิดหน้าต่างเติมของ เพื่อตรวจ/แก้ราคา และคำนวณต้นทุน
      this.openQuickRestockModal(itemId, delta);
      return;
    }

    const item = (this.data.stockItems || []).find(x => x.id === itemId);
    if (!item) return;

    const oldQty = Number(item.qty) || 0;
    const newQty = Math.max(0, oldQty + delta);
    if (oldQty === newQty) return;

    // เมื่อกดปุ่ม - เรียก setExactStockQty เพื่อตัดสต๊อกและคิดกำไรอัตโนมัติทันที โดยไม่ต้องมี popup หรือกดยืนยัน
    this.setExactStockQty(itemId, newQty);
  }

  // เปิดหน้าต่างเติมของเข้าร้าน & คำนวณต้นทุนเฉลี่ยถ่วงน้ำหนัก (Moving Average Cost)
  openQuickRestockModal(itemId, defaultAddQty = 1) {
    const item = (this.data.stockItems || []).find(x => x.id === itemId);
    if (!item) return;

    const modal = document.getElementById('quickRestockModal');
    const form = document.getElementById('quickRestockForm');
    if (!modal || !form) return;

    const currentQty = Number(item.qty) || 0;
    const currentUnitCost = Number(item.unitCost) || 0;
    const unit = item.unit || 'หน่วย';
    const isBulk = (Number(item.crateBottles) > 1);
    const crateBottles = Number(item.crateBottles) || 1;
    const rawUnit = item.rawUnit || 'ลัง';

    form.reset();
    document.getElementById('quickRestockItemId').value = item.id;
    document.getElementById('quickRestockModalTitle').textContent = `เติมสต๊อก: ${item.name}`;
    document.getElementById('quickRestockItemSub').textContent = isBulk
      ? `หมวด: ${item.category || 'ทั่วไป'} | บรรจุ ${crateBottles} ${unit}/${rawUnit} | คำนวณต้นทุนเฉลี่ย & ลงรายจ่ายอัตโนมัติ`
      : `หมวด: ${item.category || 'ทั่วไป'} | คำนวณต้นทุนเฉลี่ยถ่วงน้ำหนัก & ลงรายจ่ายอัตโนมัติ`;

    document.getElementById('quickRestockCurrentQtyLabel').textContent = isBulk
      ? `${currentQty} ${unit} (~${(currentQty / crateBottles).toFixed(2).replace(/\.?0+$/, '')} ${rawUnit})`
      : `${currentQty} ${unit}`;
    document.getElementById('quickRestockCurrentCostLabel').textContent = this.formatCurrency(currentUnitCost);
    document.getElementById('quickRestockUnitLabel').textContent = unit;

    // ค่าเริ่มต้น
    const addInput = document.getElementById('quickRestockAddQty');
    const priceInput = document.getElementById('quickRestockNewPrice');
    const dateInput = document.getElementById('quickRestockDate');
    const supInput = document.getElementById('quickRestockSupplier');

    if (addInput) addInput.value = defaultAddQty;
    const defaultTotalExpense = parseFloat((defaultAddQty * currentUnitCost).toFixed(2));
    if (priceInput) priceInput.value = defaultTotalExpense;
    if (dateInput) dateInput.value = this.formatDate(new Date());
    if (supInput) supInput.value = item.supplier || '';
    const noteInput = document.getElementById('quickRestockNote');
    if (noteInput) noteInput.value = '';

    // ฟังก์ชันคำนวณสด
    const updatePreview = () => {
      const addQty = parseFloat(addInput?.value) || 0;
      const expenseAmount = parseFloat(priceInput?.value) || 0;
      const totalQty = currentQty + addQty;

      // ต้นทุนต่อหน่วยของการซื้อรอบนี้ = ยอดเงินรวม / จำนวนที่ซื้อ
      const unitCostThisRound = addQty > 0 ? (expenseAmount / addQty) : 0;

      // สูตรต้นทุนเฉลี่ยถ่วงน้ำหนัก (Moving Average Cost)
      // ((จำนวนเดิม * ทุนเดิม) + ยอดเงินรวมรอบนี้) / จำนวนรวม
      let weightedAvgCost = currentUnitCost;
      if (totalQty > 0) {
        const totalCostSum = (currentQty * currentUnitCost) + expenseAmount;
        weightedAvgCost = parseFloat((totalCostSum / totalQty).toFixed(4));
      }

      const expEl = document.getElementById('quickRestockTotalExpensePreview');
      const qtyEl = document.getElementById('quickRestockTotalQtyPreview');
      const avgEl = document.getElementById('quickRestockAvgCostPreview');
      const diffEl = document.getElementById('quickRestockDiffLabel');

      if (expEl) expEl.textContent = this.formatCurrency(expenseAmount);
      if (qtyEl) {
        if (isBulk) {
          const equiv = (totalQty / crateBottles).toFixed(2).replace(/\.?0+$/, '');
          qtyEl.textContent = `${totalQty} ${unit} (~${equiv} ${rawUnit})`;
        } else {
          qtyEl.textContent = `${totalQty} ${unit}`;
        }
      }

      const diffVal = parseFloat((weightedAvgCost - currentUnitCost).toFixed(4));

      if (avgEl) {
        avgEl.textContent = `฿${this.formatUnitCost(weightedAvgCost)} / ${unit}`;
        if (diffVal > 0) {
          avgEl.style.color = '#ef4444'; // ราคาเฉลี่ยแพงขึ้น
        } else if (diffVal < 0) {
          avgEl.style.color = '#10b981'; // ราคาเฉลี่ยถูกลง
        } else {
          avgEl.style.color = 'var(--text-main)';
        }
      }

      if (diffEl) {
        const unitCostText = addQty > 0 ? ` (เฉลี่ย ฿${this.formatUnitCost(unitCostThisRound)}/${unit})` : '';
        if (diffVal > 0) {
          diffEl.textContent = `🔺 แพงขึ้น +฿${this.formatUnitCost(diffVal)} จากทุนเดิม (฿${this.formatUnitCost(currentUnitCost)})${unitCostText}`;
          diffEl.style.color = '#ef4444';
        } else if (diffVal < 0) {
          diffEl.textContent = `🔻 ถูกลง -฿${this.formatUnitCost(Math.abs(diffVal))} จากทุนเดิม (฿${this.formatUnitCost(currentUnitCost)})${unitCostText}`;
          diffEl.style.color = '#10b981';
        } else {
          diffEl.textContent = `⚖️ เท่ากับราคาเดิม (฿${this.formatUnitCost(currentUnitCost)})${unitCostText}`;
          diffEl.style.color = 'var(--text-muted)';
        }
      }
    };

    if (addInput) addInput.oninput = updatePreview;
    if (priceInput) priceInput.oninput = updatePreview;
    updatePreview();

    modal.classList.add('active');
    this.refreshLucide();
    setTimeout(() => {
      if (addInput) {
        addInput.focus();
        addInput.select();
      }
    }, 150);
  }

  // ยืนยันการเติมของ & บันทึกค่าใช้จ่าย & ปรับต้นทุนเฉลี่ย
  handleQuickRestockSubmit() {
    const itemId = document.getElementById('quickRestockItemId')?.value;
    const item = (this.data.stockItems || []).find(x => x.id === itemId);
    if (!item) return;

    const addQty = parseFloat(document.getElementById('quickRestockAddQty')?.value) || 0;
    const totalExpense = parseFloat(document.getElementById('quickRestockNewPrice')?.value) || 0;
    const purchaseDate = document.getElementById('quickRestockDate')?.value || this.formatDate(new Date());
    const supplier = document.getElementById('quickRestockSupplier')?.value.trim() || item.supplier || '';
    const customNote = document.getElementById('quickRestockNote')?.value.trim() || '';

    if (addQty <= 0) {
      this.showToast('กรุณาระบุจำนวนที่ซื้อเพิ่มอย่างน้อย 1', 'error');
      return;
    }

    const currentQty = Number(item.qty) || 0;
    const currentUnitCost = Number(item.unitCost) || 0;
    const totalQty = currentQty + addQty;
    const unitPriceThisRound = addQty > 0 ? (totalExpense / addQty) : 0;

    // คำนวณต้นทุนเฉลี่ยถ่วงน้ำหนัก (Moving Average Cost)
    let newAvgCost = currentUnitCost;
    if (totalQty > 0) {
      const sumValue = (currentQty * currentUnitCost) + totalExpense;
      newAvgCost = parseFloat((sumValue / totalQty).toFixed(4));
    }

    // 1. อัปเดตสต๊อกสินค้า
    item.qty = totalQty;
    item.unitCost = newAvgCost;
    if (supplier) item.supplier = supplier;

    // 2. สร้างบิลรายจ่ายลงในเดือนนั้นอัตโนมัติ (Expenses)
    if (!Array.isArray(this.data.expenses)) {
      this.data.expenses = [];
    }

    const isBulk = (Number(item.crateBottles) > 1);
    const crateBottles = Number(item.crateBottles) || 1;
    const rawUnit = item.rawUnit || 'ลัง';

    const newExpense = {
      id: 'e_' + Date.now() + Math.random().toString(36).substring(2, 5),
      date: purchaseDate,
      title: item.name,
      category: item.category || 'INGREDIENT',
      amount: totalExpense,
      qtyDesc: isBulk
        ? `${addQty} ${item.unit || 'หน่วย'} (~${(addQty / crateBottles).toFixed(2).replace(/\.?0+$/, '')} ${rawUnit}) @ ฿${this.formatUnitCost(unitPriceThisRound)}/${item.unit || 'หน่วย'}`
        : `${addQty} ${item.unit || 'หน่วย'} (รวม ฿${totalExpense} เฉลี่ย ฿${this.formatUnitCost(unitPriceThisRound)}/${item.unit || 'หน่วย'})`,
      packSize: isBulk ? parseFloat((addQty / crateBottles).toFixed(2)) : addQty,
      packUnit: isBulk ? rawUnit : (item.unit || 'หน่วย'),
      crateBottles: isBulk ? crateBottles : null,
      minQty: item.minQty,
      supplier: supplier,
      note: customNote
        ? `${customNote} (เติมสต๊อกด่วน: ทุนเดิม ฿${this.formatUnitCost(currentUnitCost)} → ทุนเฉลี่ยใหม่ ฿${this.formatUnitCost(newAvgCost)}/${item.unit || 'หน่วย'})`
        : `เติมสต๊อกด่วน: ทุนเดิม ฿${this.formatUnitCost(currentUnitCost)} → ทุนเฉลี่ยใหม่ ฿${this.formatUnitCost(newAvgCost)}/${item.unit || 'หน่วย'}`,
      stockItemId: item.id
    };
    this.data.expenses.unshift(newExpense);

    // 3. บันทึก Stock Log
    const crateSub = isBulk ? ` (~${(addQty / crateBottles).toFixed(2).replace(/\.?0+$/, '')} ${rawUnit})` : '';
    const supTag = supplier ? ` [ซื้อจาก: ${supplier}]` : '';
    const noteTag = customNote ? ` [หมายเหตุ: ${customNote}]` : '';
    const logNote = `ซื้อเพิ่ม +${addQty} ${item.unit || ''}${crateSub} (ราคารวม ฿${totalExpense} เฉลี่ย ฿${this.formatUnitCost(unitPriceThisRound)}/${item.unit || ''}) บันทึกรายจ่าย ฿${totalExpense} ทุนเฉลี่ยปรับเป็น ฿${this.formatUnitCost(newAvgCost)}${supTag}${noteTag}`;
    this.logStockAction(item.name, 'RESTOCK', addQty, totalQty, item.unit || '', logNote, {
      itemId: item.id,
      date: purchaseDate,
      expenseId: newExpense.id,
      prevUnitCost: currentUnitCost
    });

    // 4. บันทึกและรีเฟรชทุกหน้าจอ
    this.saveData();
    this.syncRecipesWithExpenses();
    document.getElementById('quickRestockModal')?.classList.remove('active');

    this.renderStock();
    this.renderLowStockAlertView();
    this.renderExpenses();
    this.renderRecipes();
    this.calculatePricing();
    this.renderDashboard();

    this.showToast(`เติมสต๊อก ${item.name} +${addQty} สำเร็จ! บันทึกรายจ่าย ฿${this.formatCurrency(totalExpense)} และปรับต้นทุนเฉลี่ยเป็น ฿${newAvgCost} เรียบร้อย 🎉`, 'success');
  }

  // เปิดหน้าต่างเบิกขายสินค้าสำเร็จรูป/ลัง & คิดกำไรสุทธิ
  openStockUseProfitModal(itemId, defaultUseQty = 1) {
    const item = (this.data.stockItems || []).find(x => x.id === itemId);
    if (!item) return;

    if (item.category === 'PACKAGING' || item.category === 'INGREDIENT' || item.category === 'OTHER') {
      this.showToast('รายการนี้เป็นบรรจุภัณฑ์/วัตถุดิบ ไม่ใช่สินค้าสำหรับเบิกขายคิดกำไร', 'warning');
      return;
    }

    const modal = document.getElementById('stockUseProfitModal');
    const form = document.getElementById('stockUseProfitForm');
    if (!modal || !form) return;

    form.reset();
    document.getElementById('stockUseProfitItemId').value = item.id;
    document.getElementById('stockUseProfitModalTitle').textContent = `เบิกขาย: ${item.name} & คิดกำไร`;

    const currentQty = Number(item.qty) || 0;
    const currentUnitCost = Number(item.unitCost) || 0;
    const unit = item.unit || 'หน่วย';
    const isBulk = (Number(item.crateBottles) > 1);
    const crateBottles = Number(item.crateBottles) || 1;
    const rawUnit = item.rawUnit || 'ลัง';

    const catName = item.category === 'FRIDGE_DRINK' ? 'น้ำขายในตู้' : (item.category === 'STOCK' ? 'สำเร็จรูป/ลัง' : (item.category || 'สินค้า'));
    document.getElementById('stockUseProfitItemSub').textContent = isBulk
      ? `หมวด: ${catName} | บรรจุ ${crateBottles} ${unit}/${rawUnit} | คำนวณกำไรสุทธิและบันทึกประวัติการเบิกขาย`
      : `หมวด: ${catName} | คำนวณกำไรสุทธิและบันทึกประวัติการเบิกขาย`;

    // หาราคาขายเริ่มต้น: ถ้ามี sellingPrice ใช้ค่านั้น หรือหาจาก savedProducts หรือตั้งต้นทุน * 1.3
    let initialSellingPrice = Number(item.sellingPrice) || 0;
    if (initialSellingPrice <= 0 && Array.isArray(this.data.savedProducts)) {
      const cleanItemName = item.name.trim().toLowerCase();
      const matchedSaved = this.data.savedProducts.find(p => p.name && (p.name.trim().toLowerCase() === cleanItemName || cleanItemName.includes(p.name.trim().toLowerCase()) || p.name.trim().toLowerCase().includes(cleanItemName)));
      if (matchedSaved && Number(matchedSaved.sellingPrice) > 0) {
        initialSellingPrice = Number(matchedSaved.sellingPrice);
      }
    }
    if (initialSellingPrice <= 0 && currentUnitCost > 0) {
      initialSellingPrice = Math.ceil(currentUnitCost * 1.3);
    }

    document.getElementById('stockUseProfitCurrentQtyLabel').textContent = isBulk
      ? `${currentQty} ${unit} (~${(currentQty / crateBottles).toFixed(2).replace(/\.?0+$/, '')} ${rawUnit})`
      : `${currentQty} ${unit}`;
    document.getElementById('stockUseProfitCurrentCostLabel').textContent = `฿${this.formatCurrency(currentUnitCost)}`;
    document.getElementById('stockUseProfitUnitLabel').textContent = unit;

    const qtyInput = document.getElementById('stockUseProfitQty');
    const sellPriceInput = document.getElementById('stockUseProfitSellingPrice');
    const dateInput = document.getElementById('stockUseProfitDate');
    const noteInput = document.getElementById('stockUseProfitNote');
    const addSalesCb = document.getElementById('stockUseProfitAddToDailySales');

    if (qtyInput) {
      qtyInput.value = defaultUseQty > 0 ? defaultUseQty : 1;
    }
    if (sellPriceInput) {
      sellPriceInput.value = initialSellingPrice > 0 ? initialSellingPrice : '';
    }
    if (dateInput) {
      dateInput.value = this.formatDate(new Date());
    }
    if (noteInput) {
      noteInput.value = '';
    }
    if (addSalesCb) {
      addSalesCb.checked = true;
    }

    // ฟังก์ชันคำนวณสด
    const updatePreview = () => {
      const qty = parseFloat(qtyInput?.value) || 0;
      const sellPrice = parseFloat(sellPriceInput?.value) || 0;
      const totalRevenue = parseFloat((qty * sellPrice).toFixed(2));
      const totalCost = parseFloat((qty * currentUnitCost).toFixed(2));
      const totalProfit = parseFloat((totalRevenue - totalCost).toFixed(2));
      const unitProfit = parseFloat((sellPrice - currentUnitCost).toFixed(2));
      const marginPct = totalRevenue > 0 ? parseFloat(((totalProfit / totalRevenue) * 100).toFixed(1)) : 0;
      const remaining = currentQty - qty;

      const revEl = document.getElementById('stockUseProfitTotalRevenuePreview');
      const costEl = document.getElementById('stockUseProfitTotalCostPreview');
      const profitEl = document.getElementById('stockUseProfitTotalProfitPreview');
      const marginEl = document.getElementById('stockUseProfitMarginPctPreview');
      const perUnitHint = document.getElementById('stockUseProfitPerUnitHint');
      const remEl = document.getElementById('stockUseProfitRemainingPreview');

      if (revEl) revEl.textContent = this.formatCurrency(totalRevenue);
      if (costEl) costEl.textContent = this.formatCurrency(totalCost);

      if (profitEl) {
        if (totalProfit > 0) {
          profitEl.textContent = `+฿${this.formatCurrency(totalProfit)}`;
          profitEl.style.color = '#15803d';
        } else if (totalProfit < 0) {
          profitEl.textContent = `-฿${this.formatCurrency(Math.abs(totalProfit))}`;
          profitEl.style.color = '#dc2626';
        } else {
          profitEl.textContent = `฿0.00`;
          profitEl.style.color = 'var(--text-main)';
        }
      }

      if (marginEl) {
        marginEl.textContent = `${marginPct}%`;
        marginEl.className = totalProfit > 0 ? 'pill-tag green-tag' : (totalProfit < 0 ? 'pill-tag red-tag' : 'pill-tag blue-tag');
      }

      if (perUnitHint) {
        if (sellPrice > 0) {
          if (unitProfit >= 0) {
            perUnitHint.textContent = `กำไรต่อ${unit}: +฿${unitProfit.toFixed(2)}`;
            perUnitHint.style.color = '#15803d';
          } else {
            perUnitHint.textContent = `ขาดทุนต่อ${unit}: -฿${Math.abs(unitProfit).toFixed(2)}`;
            perUnitHint.style.color = '#dc2626';
          }
        } else {
          perUnitHint.textContent = `กำไรต่อหน่วย: -`;
          perUnitHint.style.color = 'var(--text-muted)';
        }
      }

      if (remEl) {
        if (isBulk) {
          const equiv = (remaining / crateBottles).toFixed(2).replace(/\.?0+$/, '');
          remEl.textContent = `คงเหลือหลังเบิก: ${remaining} ${unit} (~${equiv} ${rawUnit})`;
        } else {
          remEl.textContent = `คงเหลือหลังเบิก: ${remaining} ${unit}`;
        }
        if (remaining < 0) {
          remEl.style.color = '#dc2626';
          remEl.textContent += ' ⚠️ (เกินสต๊อกที่มี)';
        } else {
          remEl.style.color = 'var(--text-muted)';
        }
      }
    };

    if (qtyInput) qtyInput.oninput = updatePreview;
    if (sellPriceInput) sellPriceInput.oninput = updatePreview;
    updatePreview();

    modal.classList.add('active');
    this.refreshLucide();
    setTimeout(() => {
      if (sellPriceInput && (!sellPriceInput.value || parseFloat(sellPriceInput.value) <= 0)) {
        sellPriceInput.focus();
        sellPriceInput.select();
      } else if (qtyInput) {
        qtyInput.focus();
        qtyInput.select();
      }
    }, 150);
  }

  // ยืนยันการเบิกขาย & คิดกำไร & ตัดสต๊อก
  handleStockUseProfitSubmit() {
    const itemId = document.getElementById('stockUseProfitItemId')?.value;
    const item = (this.data.stockItems || []).find(x => x.id === itemId);
    if (!item) return;

    if (item.category === 'PACKAGING' || item.category === 'INGREDIENT' || item.category === 'OTHER') {
      this.showToast('รายการนี้เป็นบรรจุภัณฑ์/วัตถุดิบ ไม่ใช่สินค้าสำหรับเบิกขายคิดกำไร', 'warning');
      return;
    }

    const useQty = parseFloat(document.getElementById('stockUseProfitQty')?.value) || 0;
    const sellPrice = parseFloat(document.getElementById('stockUseProfitSellingPrice')?.value) || 0;
    const saleDate = document.getElementById('stockUseProfitDate')?.value || this.formatDate(new Date());
    const userNote = document.getElementById('stockUseProfitNote')?.value.trim() || '';
    const addToDailySales = document.getElementById('stockUseProfitAddToDailySales')?.checked ?? true;

    if (useQty <= 0) {
      this.showToast('กรุณาระบุจำนวนที่ต้องการเบิกขายอย่างน้อย 0.01', 'error');
      return;
    }

    const currentQty = Number(item.qty) || 0;
    const currentUnitCost = Number(item.unitCost) || 0;
    const unit = item.unit || 'หน่วย';

    // อนุญาตให้ตัดสต๊อกได้ทันทีโดยไม่ต้องเด้ง confirm บล็อกผู้ใช้

    const newQty = Math.max(0, currentQty - useQty);
    const totalRevenue = parseFloat((useQty * sellPrice).toFixed(2));
    const totalCost = parseFloat((useQty * currentUnitCost).toFixed(2));
    const totalProfit = parseFloat((totalRevenue - totalCost).toFixed(2));

    // 1. อัปเดตสต๊อกสินค้า และจำราคาขายไว้
    item.qty = newQty;
    if (sellPrice > 0) {
      item.sellingPrice = sellPrice;
    }

    // 2. บันทึก Stock Log พร้อมกำไรที่ได้
    const isBulk = (Number(item.crateBottles) > 1);
    const crateBottles = Number(item.crateBottles) || 1;
    const rawUnit = item.rawUnit || 'ลัง';
    const crateSub = isBulk ? ` (~${(useQty / crateBottles).toFixed(2).replace(/\.?0+$/, '')} ${rawUnit})` : '';

    const profitStr = totalProfit >= 0 ? `+฿${totalProfit.toFixed(2)}` : `-฿${Math.abs(totalProfit).toFixed(2)}`;
    const logNote = `เบิกขาย ${useQty} ${unit}${crateSub} (@฿${sellPrice.toFixed(2)} ทุน ฿${this.formatUnitCost(currentUnitCost)}) กำไร ${profitStr}${addToDailySales ? ' [ลงยอดขายวันนี้แล้ว]' : ''}${userNote ? ' • ' + userNote : ''}`;
    this.logStockAction(item.name, 'USE', -useQty, newQty, unit, logNote, {
      itemId: item.id,
      date: saleDate,
      profit: totalProfit,
      revenue: totalRevenue,
      cost: totalCost,
      sellingPrice: sellPrice,
      unitCost: currentUnitCost,
      isStockSale: true,
      category: item.category || 'STOCK'
    });

    // 3. ถ้าติ๊กบันทึกเข้า Daily Sales (ยอดขายรายวัน)
    if (addToDailySales && (totalRevenue > 0 || totalCost > 0)) {
      if (!Array.isArray(this.data.dailySales)) {
        this.data.dailySales = [];
      }

      const existingIndex = this.data.dailySales.findIndex(d => d.date === saleDate);
      if (existingIndex !== -1) {
        const ex = this.data.dailySales[existingIndex];
        ex.revenue = parseFloat(((Number(ex.revenue) || 0) + totalRevenue).toFixed(2));
        ex.cost = parseFloat(((Number(ex.cost) || 0) + totalCost).toFixed(2));
        ex.materialCost = parseFloat(((Number(ex.materialCost) || 0) + totalCost).toFixed(2));
        ex.profit = parseFloat(((Number(ex.profit) || 0) + totalProfit).toFixed(2));
        const saleDesc = `ขาย ${item.name} x${useQty} ${unit} (กำไร ${profitStr})`;
        ex.note = ex.note ? `${ex.note}, ${saleDesc}` : saleDesc;
      } else {
        const costInfo = this.getSystemCostForDate(saleDate, totalRevenue);
        const dailyRent = costInfo.dailyRent || 0;
        const newRecord = {
          id: 'd_' + Date.now(),
          date: saleDate,
          revenue: totalRevenue,
          cost: parseFloat((totalCost + dailyRent).toFixed(2)),
          materialCost: totalCost,
          dailyRent: dailyRent,
          profit: parseFloat((totalRevenue - totalCost - dailyRent).toFixed(2)),
          note: `ขาย ${item.name} x${useQty} ${unit} (กำไร ${profitStr})`
        };
        this.data.dailySales.unshift(newRecord);
      }
    }

    // 4. บันทึกและรีเฟรชทุกหน้าจอ
    this.saveData();
    document.getElementById('stockUseProfitModal')?.classList.remove('active');

    this.renderStock();
    this.renderLowStockAlertView();
    this.renderDashboard();
    this.renderTodaySummary(saleDate);
    this.renderCalendar();
    this.renderStockHistory();

    const toastMsg = totalProfit >= 0
      ? `✅ เบิกขาย "${item.name}" ${useQty} ${unit} สำเร็จ! ได้กำไร +${this.formatCurrency(totalProfit)} (คงเหลือ ${newQty} ${unit})`
      : `⚠️ เบิกขาย "${item.name}" ${useQty} ${unit} ขาดทุน -${this.formatCurrency(Math.abs(totalProfit))} (คงเหลือ ${newQty} ${unit})`;
    this.showToast(toastMsg, totalProfit >= 0 ? 'success' : 'info');
  }


  // Helper: แยกแยะและดึงข้อมูลกำไร ยอดขาย ต้นทุน จาก Stock Log
  parseProfitInfoFromLog(log) {
    if (!log) return null;
    let profit = null;
    let revenue = null;
    let cost = null;

    if (log.profit !== null && log.profit !== undefined && !isNaN(Number(log.profit))) {
      profit = Number(log.profit);
      revenue = log.revenue !== null && log.revenue !== undefined ? Number(log.revenue) : null;
      cost = log.cost !== null && log.cost !== undefined ? Number(log.cost) : null;
    } else if (log.note) {
      // Regex parse จาก note เช่น "กำไร +฿50.00" หรือ "กำไรที่ได้ +฿50.00" หรือ "กำไร -฿10.00"
      const profitMatch = log.note.match(/กำไร(?:ที่ได้)?\s*([+-]?)\s*฿?([0-9,]+(?:\.[0-9]+)?)/);
      if (profitMatch) {
        const sign = profitMatch[1] === '-' ? -1 : 1;
        const val = parseFloat(profitMatch[2].replace(/,/g, '')) || 0;
        profit = sign * val;
      }
      const revMatch = log.note.match(/@฿([0-9,]+(?:\.[0-9]+)?)/);
      const costMatch = log.note.match(/ทุน\s*฿([0-9,]+(?:\.[0-9]+)?)/);
      const qty = Math.abs(Number(log.changeQty) || 1);
      if (revMatch) revenue = (parseFloat(revMatch[1].replace(/,/g, '')) || 0) * qty;
      if (costMatch) cost = (parseFloat(costMatch[1].replace(/,/g, '')) || 0) * qty;
    }

    if (profit === null) return null;
    return {
      profit: parseFloat(profit.toFixed(2)),
      revenue: revenue !== null ? parseFloat(revenue.toFixed(2)) : 0,
      cost: cost !== null ? parseFloat(cost.toFixed(2)) : 0
    };
  }

  // ตรวจสอบว่าสินค้าในสต๊อกถูกใช้เป็นวัตถุดิบ/บรรจุภัณฑ์ในการ "แพ็คขาย" หรือไม่
  isItemUsedAsPackSellRawMaterial(itemOrInfo) {
    if (!itemOrInfo) return false;
    const packLogs = this.data.packSellLogs || [];
    if (packLogs.length === 0) return false;

    const itemId = itemOrInfo.id ? String(itemOrInfo.id) : '';
    const itemNameNorm = this.normalizeProductName(itemOrInfo.name || itemOrInfo.itemName || '');
    // ถ้าเป็นสินค้าแพ็คขายสำเร็จรูปที่สร้างขึ้นเอง (เช่น "... (แพ็คขาย ...)") ให้ถือว่าขายคิดกำไรได้
    if (packLogs.some(l => l && l.stockItemId && itemId && String(l.stockItemId) === itemId)) {
      return false;
    }
    if (itemNameNorm.includes('(แพ็คขาย')) {
      return false;
    }

    const usedExpIds = new Set();
    const usedRawNames = new Set();
    packLogs.forEach(l => {
      if (!l) return;
      if (Array.isArray(l.matIds)) l.matIds.forEach(id => usedExpIds.add(String(id)));
      if (Array.isArray(l.pkgIds)) l.pkgIds.forEach(id => usedExpIds.add(String(id)));
      if (l.matName) {
        String(l.matName).split(' + ').forEach(n => {
          const norm = this.normalizeProductName(n);
          if (norm) usedRawNames.add(norm);
        });
      }
      if (l.pkgName) {
        String(l.pkgName).split(' + ').forEach(n => {
          const norm = this.normalizeProductName(n);
          if (norm) usedRawNames.add(norm);
        });
      }
    });

    if (itemNameNorm && usedRawNames.has(itemNameNorm)) return true;

    const allExpenses = this.data.expenses || [];
    return allExpenses.some(e => {
      if (!e || !usedExpIds.has(String(e.id))) return false;
      if (itemId && e.stockItemId && String(e.stockItemId) === itemId) return true;
      if (itemNameNorm && e.title && this.normalizeProductName(e.title) === itemNameNorm) return true;
      return false;
    });
  }

  // รวบรวมข้อมูลกำไรสต๊อกสำหรับวันที่กำหนด
  getStockProfitDataForDate(targetDateStr) {
    const logs = this.data.stockLogs || [];
    const dateLogs = logs.filter(l => l.date === targetDateStr && (l.actionType === 'USE' || l.actionType === 'DIRECT_SET' || Number(l.changeQty) < 0));

    let totalProfit = 0;
    let totalRevenue = 0;
    let totalCost = 0;
    let totalQty = 0;
    const saleItems = [];

    dateLogs.forEach(log => {
      // กรองออก: บรรจุภัณฑ์ (PACKAGING), วัตถุดิบ (INGREDIENT), อื่นๆ (OTHER) และวัตถุดิบที่ถูกใช้ในแพ็คขาย
      if (log.category === 'PACKAGING' || log.category === 'INGREDIENT' || log.category === 'OTHER') return;
      if (this.isItemUsedAsPackSellRawMaterial({ id: log.itemId, name: log.itemName })) return;
      if (log.itemId) {
        const matchItem = (this.data.stockItems || []).find(x => x.id === log.itemId);
        if (matchItem && (matchItem.category === 'PACKAGING' || matchItem.category === 'INGREDIENT' || matchItem.category === 'OTHER')) return;
      }
      if (log.itemName) {
        const matchItem = (this.data.stockItems || []).find(x => x.name === log.itemName);
        if (matchItem && (matchItem.category === 'PACKAGING' || matchItem.category === 'INGREDIENT' || matchItem.category === 'OTHER')) return;
        const lName = log.itemName.toLowerCase();
        if (lName.includes('แก้ว') || lName.includes('ฝา') || lName.includes('หลอด') || lName.includes('ถุงแก้ว') || lName.includes('ถุงหิ้ว')) return;
      }

      if (!log.id) {
        log.id = 'log_' + Date.now() + Math.random().toString(36).substring(2, 5);
      }
      const parsed = this.parseProfitInfoFromLog(log);
      if (parsed !== null) {
        const qty = Math.abs(Number(log.changeQty) || 0);
        totalProfit += parsed.profit;
        totalRevenue += parsed.revenue;
        totalCost += parsed.cost;
        totalQty += qty;
        saleItems.push({
          id: log.id,
          time: log.time || '-',
          itemName: log.itemName,
          qty: qty,
          unit: log.unit || 'หน่วย',
          profit: parsed.profit,
          revenue: parsed.revenue,
          cost: parsed.cost,
          note: log.note || ''
        });
      }
    });

    const marginPct = totalRevenue > 0 ? ((totalProfit / totalRevenue) * 100) : 0;

    return {
      date: targetDateStr,
      totalProfit: parseFloat(totalProfit.toFixed(2)),
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      totalCost: parseFloat(totalCost.toFixed(2)),
      totalQty: totalQty,
      marginPct: parseFloat(marginPct.toFixed(1)),
      items: saleItems
    };
  }

  // ยกเลิกการเบิก / คืนค่าสต๊อกสินค้าและย้อนคืนกำไร (เผื่อผู้ใช้ป้อนผิดหรือเบิกผิดพลาด)
  revertStockUse(logId) {
    if (!logId) return;
    const logs = this.data.stockLogs || [];
    const logIndex = logs.findIndex(l => l.id === logId);
    if (logIndex === -1) {
      this.showToast('ไม่พบรายการเบิกที่ต้องการคืนค่าในระบบ', 'error');
      return;
    }

    const log = logs[logIndex];
    const qtyToRestore = Math.abs(Number(log.changeQty) || 0);
    if (qtyToRestore <= 0) {
      this.showToast('รายการนี้ไม่มีจำนวนที่ต้องคืนค่า', 'info');
      return;
    }

    const itemName = log.itemName;
    const unit = log.unit || 'หน่วย';
    const logDate = log.date || this.formatDate(new Date());
    const parsed = this.parseProfitInfoFromLog(log);

    // 1. คืนจำนวนสต๊อกสินค้ากลับเข้าคลัง
    let item = null;
    if (log.itemId) {
      item = (this.data.stockItems || []).find(x => x.id === log.itemId);
    }
    if (!item) {
      item = (this.data.stockItems || []).find(x => x.name === itemName);
    }

    let newQty = 0;
    if (item) {
      item.qty = parseFloat(((Number(item.qty) || 0) + qtyToRestore).toFixed(2));
      newQty = item.qty;
    }

    // 2. ปรับลดยอดขาย ต้นทุน และกำไรใน dailySales ของวันที่เบิก
    if (parsed && (parsed.revenue > 0 || parsed.cost > 0 || parsed.profit !== 0)) {
      if (Array.isArray(this.data.dailySales)) {
        const salesIndex = this.data.dailySales.findIndex(d => d.date === logDate);
        if (salesIndex !== -1) {
          const ex = this.data.dailySales[salesIndex];
          ex.revenue = Math.max(0, parseFloat(((Number(ex.revenue) || 0) - parsed.revenue).toFixed(2)));
          ex.cost = Math.max(0, parseFloat(((Number(ex.cost) || 0) - parsed.cost).toFixed(2)));
          ex.materialCost = Math.max(0, parseFloat(((Number(ex.materialCost) || 0) - parsed.cost).toFixed(2)));
          ex.profit = parseFloat(((Number(ex.profit) || 0) - parsed.profit).toFixed(2));

          // ถ้า revenue และ cost กลายเป็น 0 และไม่มี cupCount (สร้างขึ้นมาเฉพาะการเบิกนี้) ลบออกเพื่อไม่ให้ค้างขยะ
          if ((Number(ex.revenue) || 0) === 0 && (Number(ex.cost) || 0) === 0 && (!ex.cupCount || ex.cupCount === 0)) {
            this.data.dailySales.splice(salesIndex, 1);
          }
        }
      }
    }

    // 3. ลบรายการ log การเบิกเดิมออกจาก stockLogs
    logs.splice(logIndex, 1);

    // 4. บันทึก Stock Log แจ้งการคืนค่า (RESTOCK) เพื่อเป็นประวัติ
    this.logStockAction(itemName, 'RESTOCK', qtyToRestore, newQty, unit, `↩️ คืนค่าจากการเบิกผิดพลาด (คืนสต๊อก +${qtyToRestore} ${unit})`, {
      itemId: item ? item.id : null,
      isReversal: true
    });

    // 5. บันทึกข้อมูลและอัปเดตหน้าจอทั้งหมดทันที
    this.saveData();
    this.renderStock();
    this.renderStockProfitCard();
    this.renderStockHistory();
    this.renderLowStockAlertView();
    this.renderDashboard();
    this.renderTodaySummary(logDate);
    this.renderCalendar();

    this.showToast(`↩️ คืนค่า "${itemName}" จำนวน ${qtyToRestore} ${unit} กลับเข้าสต๊อกเรียบร้อยแล้ว`, 'success');
  }

  // ยกเลิกการเติมสต๊อก / หักคืนจำนวนสต๊อก (เผื่อผู้ใช้เติมผิดหรือบันทึกซ้ำ)
  revertStockRestock(logId) {
    if (!logId) return;
    const logs = this.data.stockLogs || [];
    const logIndex = logs.findIndex(l => l.id === logId);
    if (logIndex === -1) {
      this.showToast('ไม่พบรายการเติมสต๊อกที่ต้องการคืนค่าในระบบ', 'error');
      return;
    }

    const log = logs[logIndex];
    const qtyToRevert = Math.abs(Number(log.changeQty) || 0);
    if (qtyToRevert <= 0) {
      this.showToast('รายการนี้ไม่มีจำนวนที่ต้องคืนค่า', 'info');
      return;
    }

    const itemName = log.itemName;
    const unit = log.unit || 'หน่วย';

    // 1. หักจำนวนสต๊อกที่เติมเกินออก
    let item = null;
    if (log.itemId) {
      item = (this.data.stockItems || []).find(x => x.id === log.itemId);
    }
    if (!item) {
      item = (this.data.stockItems || []).find(x => x.name === itemName);
    }

    let newQty = 0;
    if (item) {
      item.qty = Math.max(0, parseFloat(((Number(item.qty) || 0) - qtyToRevert).toFixed(2)));
      newQty = item.qty;
      if (log.prevUnitCost !== undefined && log.prevUnitCost !== null && !isNaN(Number(log.prevUnitCost))) {
        item.unitCost = Number(log.prevUnitCost);
      }
    }

    // 2. หากมีบิลรายจ่ายที่สร้างคู่กับการเติมสต๊อกด่วน ให้ลบออกด้วย
    if (log.expenseId && Array.isArray(this.data.expenses)) {
      const expIdx = this.data.expenses.findIndex(e => e && String(e.id) === String(log.expenseId));
      if (expIdx !== -1) {
        this.data.expenses.splice(expIdx, 1);
      }
    }

    // 3. ลบรายการ log เติมสต๊อกเดิมออกจาก stockLogs
    logs.splice(logIndex, 1);

    // 4. บันทึก Stock Log แจ้งการคืนค่า
    this.logStockAction(itemName, 'USE', -qtyToRevert, newQty, unit, `↩️ คืนค่าจากการเติมสต๊อกผิดพลาด (หักคืน -${qtyToRevert} ${unit})`, {
      itemId: item ? item.id : null,
      isReversal: true
    });

    // 5. บันทึกข้อมูลและอัปเดตหน้าจอทั้งหมดทันที
    this.saveData();
    this.syncRecipesWithExpenses();
    this.renderStock();
    this.renderStockProfitCard();
    this.renderStockHistory();
    this.renderLowStockAlertView();
    this.renderExpenses();
    this.renderDashboard();

    this.showToast(`↩️ คืนค่าการเติม "${itemName}" (-${qtyToRevert} ${unit}) เรียบร้อยแล้ว`, 'success');
  }

  // Render Daily Stock Profit Card ในหน้าสต๊อก
  renderStockProfitCard() {
    const cardEl = document.getElementById('stockProfitDailyCard');
    if (!cardEl) return;

    if (!this.selectedStockProfitDate) {
      this.selectedStockProfitDate = this.formatDate(new Date());
    }

    const todayStr = this.formatDate(new Date());
    const isToday = (this.selectedStockProfitDate === todayStr);

    // Update Date Controls
    const datePicker = document.getElementById('stockProfitDatePicker');
    const labelEl = document.getElementById('stockProfitDateDisplayLabel');
    const todayBtn = document.getElementById('btnStockProfitToday');

    if (datePicker) datePicker.value = this.selectedStockProfitDate;
    if (labelEl) {
      labelEl.textContent = `ประจำวันที่ ${this.formatThaiDate(this.selectedStockProfitDate)} ${isToday ? '(วันนี้)' : ''}`;
    }
    if (todayBtn) {
      if (isToday) {
        todayBtn.className = 'btn-fastwork btn-sm';
        todayBtn.style.background = '#059669';
        todayBtn.style.borderColor = '#059669';
      } else {
        todayBtn.className = 'btn-secondary btn-sm';
        todayBtn.style.background = '';
        todayBtn.style.borderColor = '';
      }
    }

    // Get Data
    const data = this.getStockProfitDataForDate(this.selectedStockProfitDate);

    // Update Highlights
    const totalEl = document.getElementById('stockProfitDayTotalVal');
    const marginEl = document.getElementById('stockProfitDayMarginVal');
    const revEl = document.getElementById('stockProfitDayRevenueVal');
    const costEl = document.getElementById('stockProfitDayCostVal');
    const countEl = document.getElementById('stockProfitDayItemsCountVal');
    const detailBadge = document.getElementById('stockProfitDayItemsDetailBadge');
    const listEl = document.getElementById('stockProfitDayItemsList');

    if (totalEl) {
      if (data.totalProfit > 0) {
        totalEl.textContent = `+${this.formatCurrency(data.totalProfit)}`;
        totalEl.style.color = '#15803d';
      } else if (data.totalProfit < 0) {
        totalEl.textContent = `-${this.formatCurrency(Math.abs(data.totalProfit))}`;
        totalEl.style.color = '#dc2626';
      } else {
        totalEl.textContent = `฿0.00`;
        totalEl.style.color = 'var(--text-main)';
      }
    }

    if (marginEl) {
      marginEl.textContent = `${data.marginPct}%`;
      marginEl.className = data.totalProfit >= 0 ? 'text-success' : 'text-danger';
    }

    const searchInput = document.getElementById('stockProfitDaySearchInput');
    const searchClearBtn = document.getElementById('stockProfitDaySearchClearBtn');
    const searchQuery = (searchInput?.value || '').trim().toLowerCase();
    if (searchClearBtn) {
      searchClearBtn.style.display = searchQuery ? 'block' : 'none';
    }

    const filteredItems = searchQuery
      ? data.items.filter(item => {
          const name = String(item.itemName || '').toLowerCase();
          const unit = String(item.unit || '').toLowerCase();
          const time = String(item.time || '').toLowerCase();
          return name.includes(searchQuery) || unit.includes(searchQuery) || time.includes(searchQuery);
        })
      : data.items;

    if (revEl) revEl.textContent = this.formatCurrency(data.totalRevenue);
    if (costEl) costEl.textContent = this.formatCurrency(data.totalCost);
    if (countEl) countEl.textContent = `${data.items.length} รายการ`;
    if (detailBadge) {
      detailBadge.textContent = searchQuery
        ? `พบ ${filteredItems.length}/${data.items.length} รายการ`
        : `รวม ${data.totalQty} ชิ้น/ลัง`;
    }

    // Render Mini List of Items for the Day
    if (listEl) {
      if (data.items.length === 0) {
        listEl.innerHTML = `
          <div class="text-center text-muted py-3 px-2" style="font-size:0.8rem; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:var(--radius-sm); line-height:1.5;">
            <i data-lucide="package-search" style="width:20px; height:20px; color:#94a3b8; display:block; margin:0 auto 4px;"></i>
            ไม่มีรายการเบิกขายน้ำในตู้/ของแพ็คขายในวันที่เลือก<br>
            <span style="font-size:0.75rem; color:#64748b;">(คิดกำไรเฉพาะ <b>น้ำขายในตู้</b> และ <b>ของแพ็คขาย/สำเร็จรูป</b> ไม่รวมบรรจุภัณฑ์และวัตถุดิบ)</span>
          </div>
        `;
      } else if (filteredItems.length === 0) {
        listEl.innerHTML = `
          <div class="text-center text-muted py-3 px-2" style="font-size:0.8rem; background:#fffbeb; border:1px dashed #fcd34d; border-radius:var(--radius-sm); line-height:1.5;">
            ไม่พบรายการที่ตรงกับ "${this.escapeHtml(searchInput.value.trim())}"
            <div style="margin-top:0.35rem;">
              <button type="button" class="btn-outline-fastwork btn-sm" style="font-size:0.72rem; padding:0.15rem 0.55rem;"
                onclick="app.clearSearchInput('stockProfitDaySearchInput', 'renderStockProfitCard')">
                ล้างคำค้นหา
              </button>
            </div>
          </div>
        `;
      } else {
        listEl.innerHTML = filteredItems.map(item => {
          const profitColor = item.profit >= 0 ? '#15803d' : '#dc2626';
          const profitSign = item.profit >= 0 ? '+' : '';
          return `
            <div class="stock-day-sale-item">
              <div class="stock-day-item-main">
                <div class="stock-day-item-title-wrap">
                  <span class="stock-day-item-time">⏰ ${item.time}</span>
                  <b class="stock-day-item-name" title="${this.escapeHtml(item.itemName)}">${this.escapeHtml(item.itemName)}</b>
                </div>
                <span class="pill-tag purple-tag stock-day-item-qty">${item.qty} ${this.escapeHtml(item.unit)}</span>
              </div>
              <div class="stock-day-item-right">
                <div style="line-height:1.2;">
                  <span class="stock-day-item-profit" style="color:${profitColor};">${profitSign}${this.formatCurrency(item.profit)}</span>
                  <span class="stock-day-item-subinfo" title="ยอดขาย ${this.formatCurrency(item.revenue)} / ทุน ${this.formatCurrency(item.cost)}">(ขาย ${this.formatCurrency(item.revenue)})</span>
                </div>
                <button type="button" 
                  class="btn-stock-revert" 
                  onclick="app.revertStockUse('${item.id}')" 
                  title="คืนค่า/ยกเลิกการเบิกรายการนี้ (คืนสต๊อก ${item.qty} ${this.escapeHtml(item.unit)} และยกเลิกกำไร)">
                  ↩️ คืนค่า
                </button>
              </div>
            </div>
          `;
        }).join('');
      }
      this.refreshLucide();
    }
  }

  // เปลี่ยนวันที่ดูสรุปกำไร (ย้อนหลัง / ถัดไป)
  changeStockProfitDate(offset) {
    if (!this.selectedStockProfitDate) {
      this.selectedStockProfitDate = this.formatDate(new Date());
    }
    const parts = this.selectedStockProfitDate.split('-');
    if (parts.length === 3) {
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      d.setDate(d.getDate() + offset);
      this.selectedStockProfitDate = this.formatDate(d);
      this.renderStockProfitCard();
      this.refreshLucide();
    }
  }

  // ตั้งค่าวันที่ดูสรุปกำไรจาก Date Picker
  setStockProfitDate(dateStr) {
    if (!dateStr) return;
    this.selectedStockProfitDate = dateStr;
    this.renderStockProfitCard();
    this.refreshLucide();
  }

  // กลับมาดูวันที่ปัจจุบัน (วันนี้)
  setStockProfitDateToToday() {
    this.selectedStockProfitDate = this.formatDate(new Date());
    this.renderStockProfitCard();
    this.refreshLucide();
  }

  // เปิด Modal ดูประวัติสรุปกำไรย้อนหลังทั้งหมดแยกรายวัน
  openStockProfitHistoryModal() {
    const modal = document.getElementById('stockProfitHistoryModal');
    if (!modal) return;

    // Build raw logs with parsed profit info
    const logs = this.data.stockLogs || [];
    this._stockProfitRawLogs = [];

    logs.forEach(log => {
      if (log.actionType === 'USE') {
        // กรองออก: บรรจุภัณฑ์ (PACKAGING), วัตถุดิบ (INGREDIENT), อื่นๆ (OTHER) และวัตถุดิบที่ถูกใช้ในแพ็คขาย
        if (log.category === 'PACKAGING' || log.category === 'INGREDIENT' || log.category === 'OTHER') return;
        if (this.isItemUsedAsPackSellRawMaterial({ id: log.itemId, name: log.itemName })) return;
        if (log.itemId) {
          const matchItem = (this.data.stockItems || []).find(x => x.id === log.itemId);
          if (matchItem && (matchItem.category === 'PACKAGING' || matchItem.category === 'INGREDIENT' || matchItem.category === 'OTHER')) return;
        }
        if (log.itemName) {
          const matchItem = (this.data.stockItems || []).find(x => x.name === log.itemName);
          if (matchItem && (matchItem.category === 'PACKAGING' || matchItem.category === 'INGREDIENT' || matchItem.category === 'OTHER')) return;
          const lName = log.itemName.toLowerCase();
          if (lName.includes('แก้ว') || lName.includes('ฝา') || lName.includes('หลอด') || lName.includes('ถุงแก้ว') || lName.includes('ถุงหิ้ว')) return;
        }

        const parsed = this.parseProfitInfoFromLog(log);
        if (parsed !== null) {
          this._stockProfitRawLogs.push({
            date: log.date,
            itemName: log.itemName || '',
            profit: parsed.profit,
            revenue: parsed.revenue,
            cost: parsed.cost,
            qty: Math.abs(Number(log.changeQty) || 0),
            unit: log.unit || '',
            note: log.note || ''
          });
        }
      }
    });

    // Reset search/filter
    const searchEl = document.getElementById('stockProfitHistorySearch');
    const filterEl = document.getElementById('stockProfitHistoryFilter');
    const dateEl = document.getElementById('stockProfitHistoryDatePicker');
    const dateClearEl = document.getElementById('stockProfitHistoryDateClearBtn');
    if (searchEl) searchEl.value = '';
    if (filterEl) filterEl.value = 'ALL';
    if (dateEl) dateEl.value = '';
    if (dateClearEl) dateClearEl.style.display = 'none';

    this.filterStockProfitHistory();
    modal.classList.add('active');
    this.refreshLucide();
  }

  filterStockProfitHistory() {
    if (!this._stockProfitRawLogs) return;
    const searchQuery = (document.getElementById('stockProfitHistorySearch')?.value || '').toLowerCase().trim();
    const filterVal = document.getElementById('stockProfitHistoryFilter')?.value || 'ALL';
    const dateFilter = (document.getElementById('stockProfitHistoryDatePicker')?.value || '').trim();
    const dateClearEl = document.getElementById('stockProfitHistoryDateClearBtn');
    if (dateClearEl) dateClearEl.style.display = dateFilter ? 'inline-block' : 'none';

    let filtered = [...this._stockProfitRawLogs];

    // Filter by selected date
    if (dateFilter) {
      filtered = filtered.filter(r => String(r.date || '').substring(0, 10) === dateFilter);
    }

    // Search by item name, date, note, amounts
    if (searchQuery) {
      filtered = filtered.filter(r => {
        const itemName = (r.itemName || '').toLowerCase();
        const thaiDate = this.formatThaiDate(r.date).toLowerCase();
        const dateRaw = (r.date || '').toLowerCase();
        const note = (r.note || '').toLowerCase();
        const revenue = String(r.revenue || 0);
        const profit = String(r.profit || 0);
        const cost = String(r.cost || 0);
        return itemName.includes(searchQuery) || thaiDate.includes(searchQuery) ||
          dateRaw.includes(searchQuery) || note.includes(searchQuery) ||
          revenue.includes(searchQuery) || profit.includes(searchQuery) ||
          cost.includes(searchQuery);
      });
    }

    // Filter by profit/loss
    if (filterVal === 'PROFIT') {
      filtered = filtered.filter(r => r.profit >= 0);
    } else if (filterVal === 'LOSS') {
      filtered = filtered.filter(r => r.profit < 0);
    }

    // Aggregate by date
    const dateMap = {};
    filtered.forEach(r => {
      if (!dateMap[r.date]) {
        dateMap[r.date] = { date: r.date, totalProfit: 0, totalRevenue: 0, totalCost: 0, totalQty: 0, itemsCount: 0, items: [] };
      }
      dateMap[r.date].totalProfit += r.profit;
      dateMap[r.date].totalRevenue += r.revenue;
      dateMap[r.date].totalCost += r.cost;
      dateMap[r.date].totalQty += r.qty;
      dateMap[r.date].itemsCount++;
      dateMap[r.date].items.push(r);
    });
    const datesList = Object.values(dateMap).sort((a, b) => b.date.localeCompare(a.date));

    // Aggregate by item (for search summary)
    const itemMap = {};
    filtered.forEach(r => {
      const key = (r.itemName || 'ไม่ระบุชื่อ').trim();
      if (!itemMap[key]) {
        itemMap[key] = { name: key, totalProfit: 0, totalRevenue: 0, totalCost: 0, totalQty: 0, count: 0 };
      }
      itemMap[key].totalProfit += r.profit;
      itemMap[key].totalRevenue += r.revenue;
      itemMap[key].totalCost += r.cost;
      itemMap[key].totalQty += r.qty;
      itemMap[key].count++;
    });
    const itemsList = Object.values(itemMap).sort((a, b) => b.totalProfit - a.totalProfit);

    this.renderStockProfitHistoryTable(datesList, itemsList, searchQuery);
  }

  switchStockProfitHistoryTab(tab) {
    const dailyEl = document.getElementById('stockProfitHistoryTableBody');
    const itemsEl = document.getElementById('stockProfitHistoryItemsBody');
    const btnDaily = document.getElementById('btnSphTabDaily');
    const btnItems = document.getElementById('btnSphTabItems');
    const showItems = tab === 'items';
    if (dailyEl) dailyEl.style.display = showItems ? 'none' : 'flex';
    if (itemsEl) itemsEl.style.display = showItems ? 'grid' : 'none';
    if (btnDaily) btnDaily.classList.toggle('active', !showItems);
    if (btnItems) btnItems.classList.toggle('active', showItems);
  }

  renderStockProfitHistoryTable(datesList, itemsList, searchQuery) {
    const dailyWrap = document.getElementById('stockProfitHistoryTableBody');
    const itemsWrap = document.getElementById('stockProfitHistoryItemsBody');
    if (!dailyWrap) return;

    // Summary totals
    let allTimeProfit = 0;
    let allTimeRevenue = 0;
    datesList.forEach(d => {
      allTimeProfit += d.totalProfit;
      allTimeRevenue += d.totalRevenue;
    });

    const allProfitEl = document.getElementById('stockProfitHistAllTimeProfit');
    const allRevEl = document.getElementById('stockProfitHistAllTimeRevenue');
    const allDaysEl = document.getElementById('stockProfitHistTotalDays');

    if (allProfitEl) {
      allProfitEl.textContent = `${allTimeProfit >= 0 ? '+' : ''}${this.formatCurrency(allTimeProfit)}`;
      allProfitEl.style.color = allTimeProfit >= 0 ? '#15803d' : '#dc2626';
    }
    if (allRevEl) allRevEl.textContent = this.formatCurrency(allTimeRevenue);
    if (allDaysEl) allDaysEl.textContent = `${datesList.length} วัน`;

    // Render Tab 1: Clean responsive day cards (no horizontal table scroll)
    if (datesList.length === 0) {
      dailyWrap.innerHTML = `
        <div class="figma-tx-empty" style="padding:2rem 1rem;">
          <div class="figma-tx-empty-icon"><i data-lucide="inbox"></i></div>
          <div class="figma-tx-empty-title">${this._stockProfitRawLogs && this._stockProfitRawLogs.length > 0 ? 'ไม่พบรายการที่ตรงกับเงื่อนไข' : 'ยังไม่มีประวัติการเบิกขาย'}</div>
          <div class="figma-tx-empty-desc">ลองเปลี่ยนวันที่หรือคำค้นหา</div>
        </div>
      `;
    } else {
      const todayStr = this.formatDate(new Date());
      dailyWrap.innerHTML = datesList.map(row => {
        const isCurrentSelected = (row.date === this.selectedStockProfitDate);
        const isProfit = row.totalProfit >= 0;
        const profitColor = isProfit ? '#15803d' : '#dc2626';
        const profitSign = isProfit ? '+' : '';

        return `
          <div class="sph-day-card ${isCurrentSelected ? 'is-selected' : ''}">
            <div class="sph-day-left">
              <div class="sph-day-date-row">
                <span class="sph-day-date">${this.formatThaiDate(row.date)}</span>
                ${row.date === todayStr ? '<span class="pill-tag green-tag" style="font-size:0.68rem; padding:0.08rem 0.4rem;">วันนี้</span>' : ''}
                <span class="pill-tag blue-tag" style="font-size:0.7rem; padding:0.08rem 0.45rem;">${row.itemsCount} รายการ · ${row.totalQty} ชิ้น</span>
              </div>
              <div class="sph-day-sub">
                <span>ขาย <b>${this.formatCurrency(row.totalRevenue)}</b></span>
                <span style="color:#cbd5e1;">•</span>
                <span>ทุน <b>${this.formatCurrency(row.totalCost)}</b></span>
              </div>
            </div>
            <div class="sph-day-right">
              <div class="sph-day-profit" style="color:${profitColor};">
                ${profitSign}${this.formatCurrency(row.totalProfit)}
              </div>
              <button type="button" class="btn-outline-fastwork btn-sm" onclick="app.selectDateFromProfitHistory('${row.date}')"
                style="padding:0.28rem 0.65rem; font-size:0.76rem; font-weight:700; ${isCurrentSelected ? 'background:#16a34a; color:#fff; border-color:#16a34a;' : ''}">
                ${isCurrentSelected ? '✓ กำลังดู' : 'ดูรายละเอียด'}
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    // Render Tab 2: Items breakdown grid
    if (itemsWrap) {
      if (!itemsList || itemsList.length === 0) {
        itemsWrap.innerHTML = `
          <div class="figma-tx-empty" style="padding:2rem 1rem; grid-column:1 / -1;">
            <div class="figma-tx-empty-icon"><i data-lucide="package"></i></div>
            <div class="figma-tx-empty-title">ไม่มีรายการสินค้า</div>
          </div>
        `;
      } else {
        itemsWrap.innerHTML = itemsList.map(item => {
          const isProfit = item.totalProfit >= 0;
          return `
            <div class="sph-item-card ${isProfit ? 'is-profit' : 'is-loss'}">
              <div class="sph-item-name" title="${this.escapeHtml(item.name)}">${this.escapeHtml(item.name)}</div>
              <div class="sph-item-mid">
                <span class="text-xs text-muted">${item.count} ครั้ง · ${item.totalQty} ชิ้น</span>
                <span class="sph-item-profit" style="color:${isProfit ? '#15803d' : '#dc2626'};">${isProfit ? '+' : ''}${this.formatCurrency(item.totalProfit)}</span>
              </div>
              <div class="sph-item-sub">
                <span>ขาย ${this.formatCurrency(item.totalRevenue)}</span>
                <span>ทุน ${this.formatCurrency(item.totalCost)}</span>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    this.refreshLucide();
  }

  // เลือกวันจากตารางประวัติกำไร แล้วนำไปแสดงบนการ์ดหน้าสต๊อกทันที
  selectDateFromProfitHistory(dateStr) {
    this.selectedStockProfitDate = dateStr;
    this.renderStockProfitCard();
    document.getElementById('stockProfitHistoryModal')?.classList.remove('active');
    this.refreshLucide();

    // เลื่อนหน้าจอไปที่การ์ดกำไรอย่างนุ่มนวล
    const cardEl = document.getElementById('stockProfitDailyCard');
    if (cardEl) {
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  renderStockHistory() {
    const tbody = document.getElementById('stockHistoryTableBody');
    const badge = document.getElementById('stockLogsCountBadge');
    const typeFilter = document.getElementById('stockLogTypeFilter')?.value || 'ALL';
    const dateFilterInput = document.getElementById('stockLogDateFilter');
    const dateClearBtn = document.getElementById('stockLogDateClearBtn');
    const dateFilter = (dateFilterInput?.value || '').trim();
    if (dateClearBtn) {
      dateClearBtn.style.display = dateFilter ? 'inline-block' : 'none';
    }
    const searchInput = document.getElementById('stockLogSearchInput');
    const searchClearBtn = document.getElementById('stockLogSearchClearBtn');
    const searchQuery = (searchInput?.value || '').trim().toLowerCase();
    if (searchClearBtn) {
      searchClearBtn.style.display = searchQuery ? 'block' : 'none';
    }
    if (!tbody) return;

    const allLogs = this.data.stockLogs || [];
    let logs = allLogs;

    if (dateFilter) {
      logs = logs.filter(l => String(l.date || '').substring(0, 10) === dateFilter);
    }

    const isExpenseAddLog = (log) => {
      if (!log) return false;
      if (log.actionType === 'EXPENSE_ADD') return true;
      if (log.expenseId) return true;
      const noteStr = String(log.note || '');
      return noteStr.includes('จากบิลซื้อ') || noteStr.includes('บันทึกต้นทุน');
    };

    if (typeFilter !== 'ALL') {
      if (typeFilter === 'EXPENSE_ADD') {
        logs = logs.filter(l => isExpenseAddLog(l));
      } else {
        logs = logs.filter(l => l.actionType === typeFilter);
      }
    }

    if (searchQuery) {
      logs = logs.filter(l => {
        const itemName = String(l.itemName || '').toLowerCase();
        const note = String(l.note || '').toLowerCase();
        const unit = String(l.unit || '').toLowerCase();
        const dateStr = String(l.date || '').toLowerCase();
        const thaiDate = String(this.formatThaiDate(l.date) || '').toLowerCase();
        return itemName.includes(searchQuery) ||
          note.includes(searchQuery) ||
          unit.includes(searchQuery) ||
          dateStr.includes(searchQuery) ||
          thaiDate.includes(searchQuery);
      });
    }

    if (badge) {
      badge.textContent = (searchQuery || typeFilter !== 'ALL' || dateFilter)
        ? `${logs.length} / ${allLogs.length} รายการ`
        : `${allLogs.length} รายการ`;
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

    const sortedLogs = [...logs].sort((a, b) => {
      const dateA = String(a.date || '').substring(0, 10);
      const dateB = String(b.date || '').substring(0, 10);
      if (dateB !== dateA) return dateB.localeCompare(dateA);
      const timeA = String(a.time || '00:00');
      const timeB = String(b.time || '00:00');
      if (timeB !== timeA) return timeB.localeCompare(timeA);
      return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
    });

    tbody.innerHTML = sortedLogs.map(log => {
      const isUse = log.actionType === 'USE';
      const isExpenseAdd = !isUse && isExpenseAddLog(log);
      const typeBadge = isUse
        ? `<span class="pill-tag red-tag" style="font-weight:700; font-size:0.75rem;"><i data-lucide="arrow-down-circle" style="width:12px;height:12px;"></i> เบิก/ตัดใช้</span>`
        : (isExpenseAdd
          ? `<span class="pill-tag" style="font-weight:700; font-size:0.75rem; background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe;"><i data-lucide="receipt" style="width:12px;height:12px;"></i> บันทึกต้นทุน &amp; วัตถุดิบ</span>`
          : `<span class="pill-tag green-tag" style="font-weight:700; font-size:0.75rem;"><i data-lucide="arrow-up-circle" style="width:12px;height:12px;"></i> เติมสต๊อก</span>`);

      const changeSign = log.changeQty > 0 ? `+${log.changeQty}` : `${log.changeQty}`;
      const changeClass = isUse ? 'text-danger' : 'text-green';

      const isReversalLog = Boolean(log.isReversal) || String(log.note || '').includes('คืนค่าจากการ');
      const canRevertUse = isUse && (Number(log.changeQty) < 0) && Boolean(log.id) && !isReversalLog;
      const canRevertRestock = !isUse && log.actionType === 'RESTOCK' && (Number(log.changeQty) > 0) && Boolean(log.id) && !isReversalLog;
      const revertBtn = canRevertUse ? `
        <button type="button" class="btn btn-xs ml-2" onclick="app.revertStockUse('${log.id}')" title="คืนค่า/ยกเลิกรายการเบิกนี้" style="background:#fff1f2; color:#e11d48; border:1px solid #fecdd3; padding:0.15rem 0.45rem; border-radius:var(--radius-sm); font-size:0.72rem; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:0.2rem; flex-shrink:0;">
          ↩️ คืนค่า
        </button>
      ` : (canRevertRestock ? `
        <button type="button" class="btn btn-xs ml-2" onclick="app.revertStockRestock('${log.id}')" title="คืนค่า/ยกเลิกรายการเติมสต๊อกนี้" style="background:#fffbeb; color:#d97706; border:1px solid #fde68a; padding:0.15rem 0.45rem; border-radius:var(--radius-sm); font-size:0.72rem; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:0.2rem; flex-shrink:0;">
          ↩️ คืนค่า
        </button>
      ` : '');

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
            <div class="text-sm text-muted" style="line-height:1.4; display:flex; align-items:center; justify-content:space-between; gap:0.5rem;">
              <div style="min-width:0; flex:1;">${this.formatLogNote(log.note || '-')}</div>
              ${revertBtn}
            </div>
          </td>
        </tr>
      `;
    }).join('');

    this.refreshLucide();
  }

  updateStockLogDate(logId, newDate) {
    if (!logId || !newDate || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return;
    const logs = this.data.stockLogs || [];
    const log = logs.find(l => l && String(l.id) === String(logId));
    if (!log) return;
    log.date = newDate;
    this.saveData();
    this.renderStockHistory();
    this.renderStockProfitCard();
    this.showToast(`อัปเดตวันที่ประวัติ "${log.itemName}" เป็น ${this.formatThaiDate(newDate)} แล้ว`, 'success');
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

  // Format log note: Formats all stock log note types into clean visual chips/pills and clickable supplier links
  formatLogNote(noteStr) {
    if (!noteStr) return '-';
    const raw = String(noteStr).trim();

    const makeSupplierPill = (supRaw) => {
      if (!supRaw) return '';
      const parsed = this.parseSupplier(supRaw.trim());
      if (parsed.isUrl) {
        const shortLabel = parsed.name || (parsed.url.length > 28 ? parsed.url.substring(0, 25) + '...' : parsed.url);
        return `<a href="${this.escapeHtml(parsed.url)}" target="_blank" rel="noopener noreferrer"
                   class="pill-tag orange-tag"
                   style="font-size:0.7rem; font-weight:700; padding:0.1rem 0.45rem; text-decoration:none; display:inline-flex; align-items:center; gap:0.2rem; background:#ffedd5; color:#c2410c; border:1px solid #fed7aa; vertical-align:middle;"
                   title="${this.escapeHtml(parsed.url)}">
                  🔗 ${this.escapeHtml(shortLabel)} <i data-lucide="external-link" style="width:10px;height:10px;"></i>
                </a>`;
      }
      return `<span class="pill-tag orange-tag" style="font-size:0.7rem; font-weight:600; padding:0.1rem 0.45rem; background:#fff7ed; color:#c2410c; border:1px solid #fed7aa;">🛒 ${this.escapeHtml(parsed.name || supRaw)}</span>`;
    };

    const linkifyText = (text) => {
      const urlPattern = /(https?:\/\/[^\s\]\>]+)/g;
      return String(text).split(urlPattern).map(part => {
        if (part.match(/^https?:\/\//i)) {
          let cleanUrl = part;
          let trailing = '';
          while (cleanUrl.endsWith(')')) {
            const opens = (cleanUrl.match(/\(/g) || []).length;
            const closes = (cleanUrl.match(/\)/g) || []).length;
            if (closes > opens) {
              trailing = ')' + trailing;
              cleanUrl = cleanUrl.slice(0, -1);
            } else {
              break;
            }
          }
          return makeSupplierPill(cleanUrl) + this.escapeHtml(trailing);
        }
        return this.escapeHtml(part);
      }).join('');
    };

    // 1. เบิกขาย ...
    const saleMatch = raw.match(/^เบิกขาย\s+(.+?)\s*\(@฿([\d,]+(?:\.\d+)?)\s+ทุน\s+฿([\d,]+(?:\.\d+)?)\)\s*กำไร\s*([+\-]?฿[\d,]+(?:\.\d+)?)(?:\s*\[([^\]]+)\])?(.*)$/);
    if (saleMatch) {
      const qtyRaw = saleMatch[1].trim();
      const sellPrice = saleMatch[2];
      const costPrice = saleMatch[3];
      const profitStr = saleMatch[4].trim();
      const tagStr = saleMatch[5] ? saleMatch[5].trim() : '';
      const extraStr = saleMatch[6] ? saleMatch[6].trim() : '';
      const isLoss = profitStr.startsWith('-');
      const profitStyle = isLoss
        ? 'background:#fef2f2; color:#dc2626; border:1px solid #fecaca;'
        : 'background:#f0fdf4; color:#15803d; border:1px solid #bbf7d0;';

      return `
        <div style="display:flex; flex-direction:column; gap:0.28rem;">
          <div style="display:flex; align-items:center; flex-wrap:wrap; gap:0.35rem;">
            <span class="pill-tag" style="font-size:0.74rem; font-weight:700; padding:0.12rem 0.5rem; background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe;">
              🛒 เบิกขาย ${this.escapeHtml(qtyRaw)}
            </span>
            <span class="pill-tag" style="font-size:0.74rem; font-weight:700; padding:0.12rem 0.5rem; ${profitStyle}">
              ${isLoss ? '📉 ขาดทุน' : '💰 กำไร'} ${this.escapeHtml(profitStr)}
            </span>
            ${tagStr ? `<span class="pill-tag" style="font-size:0.7rem; font-weight:600; padding:0.1rem 0.45rem; background:#f8fafc; color:#475569; border:1px solid #cbd5e1;">📌 ${this.escapeHtml(tagStr)}</span>` : ''}
          </div>
          <div style="font-size:0.76rem; color:#64748b; display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
            <span>ราคาขาย <b>฿${this.escapeHtml(sellPrice)}</b></span>
            <span style="color:#cbd5e1;">•</span>
            <span>ต้นทุน <b>฿${this.escapeHtml(costPrice)}</b></span>
            ${extraStr ? `<span style="color:#cbd5e1;">•</span><span>${linkifyText(extraStr)}</span>` : ''}
          </div>
        </div>
      `;
    }

    // 2. รับเข้าของ / เพิ่มรายการใหม่ จากบิลซื้อ
    const restockBillMatch = raw.match(/^(รับเข้าของ|เพิ่มรายการใหม่|รับเข้าจากการแก้ไขบิลซื้อ)\s*(.*?)\s*จากบิลซื้อ\s*\(([^)]+)\)(?:\s*\[ซื้อจาก:\s*([^\]]+)\])?(.*)$/) ||
      raw.match(/^(รับเข้าจากการแก้ไขบิลซื้อ)\s*\(([^)]+)\)(?:\s*\[ซื้อจาก:\s*([^\]]+)\])?(.*)$/);
    if (restockBillMatch) {
      const isEditRestock = restockBillMatch[1] === 'รับเข้าจากการแก้ไขบิลซื้อ' && restockBillMatch.length <= 5;
      const actionLabel = restockBillMatch[1] === 'เพิ่มรายการใหม่' ? '✨ เพิ่มรายการใหม่' : (restockBillMatch[1].includes('แก้ไข') ? '📝 รับเข้า (แก้บิล)' : '📥 รับเข้าจากบิลซื้อ');
      const qtyDetail = isEditRestock ? '' : (restockBillMatch[2] || '').trim();
      const billDate = isEditRestock ? (restockBillMatch[2] || '').trim() : (restockBillMatch[3] || '').trim();
      const supRaw = isEditRestock ? (restockBillMatch[3] || '').trim() : (restockBillMatch[4] || '').trim();

      return `
        <div style="display:flex; flex-direction:column; gap:0.25rem;">
          <div style="display:flex; align-items:center; flex-wrap:wrap; gap:0.35rem;">
            <span class="pill-tag" style="font-size:0.73rem; font-weight:700; padding:0.12rem 0.5rem; background:#f0fdf4; color:#15803d; border:1px solid #bbf7d0;">
              ${actionLabel}${qtyDetail ? ` ${this.escapeHtml(qtyDetail)}` : ''}
            </span>
            ${supRaw ? makeSupplierPill(supRaw) : ''}
          </div>
          ${billDate ? `<div style="font-size:0.74rem; color:#64748b;">📅 บิลวันที่ <b>${this.escapeHtml(billDate)}</b></div>` : ''}
        </div>
      `;
    }

    // 3. ซื้อเพิ่ม +... (เติมสต๊อกด่วน)
    const quickRestockMatch = raw.match(/^ซื้อเพิ่ม\s+(.+?)\s*\(ราคารวม\s*฿([\d,]+(?:\.\d+)?)\s+เฉลี่ย\s*฿([^)]+)\)\s*บันทึกรายจ่าย\s*฿([\d,]+(?:\.\d+)?)\s*ทุนเฉลี่ยปรับเป็น\s*฿([\d,]+(?:\.\d+)?)(.*)$/);
    if (quickRestockMatch) {
      const qtyText = quickRestockMatch[1].trim();
      const totalExp = quickRestockMatch[2];
      const avgRound = quickRestockMatch[3].trim();
      const newAvg = quickRestockMatch[5];
      let tail = quickRestockMatch[6] || '';
      let supHtml = '';
      let noteText = '';
      const supMatch = tail.match(/\[ซื้อจาก:\s*([^\]]+)\]/);
      if (supMatch) {
        supHtml = makeSupplierPill(supMatch[1]);
      }
      const noteMatch = tail.match(/\[หมายเหตุ:\s*([^\]]+)\]/);
      if (noteMatch) {
        noteText = noteMatch[1].trim();
      }
      return `
        <div style="display:flex; flex-direction:column; gap:0.25rem;">
          <div style="display:flex; align-items:center; flex-wrap:wrap; gap:0.35rem;">
            <span class="pill-tag" style="font-size:0.73rem; font-weight:700; padding:0.12rem 0.5rem; background:#f0fdf4; color:#15803d; border:1px solid #bbf7d0;">
              🛍️ ซื้อเพิ่ม ${this.escapeHtml(qtyText)}
            </span>
            <span class="pill-tag" style="font-size:0.73rem; font-weight:700; padding:0.12rem 0.5rem; background:#fffbeb; color:#b45309; border:1px solid #fde68a;">
              🧾 จ่ายรวม ฿${this.escapeHtml(totalExp)}
            </span>
            ${supHtml}
          </div>
          <div style="font-size:0.75rem; color:#64748b; display:flex; align-items:center; flex-wrap:wrap; gap:0.4rem;">
            <span>รอบนี้เฉลี่ย <b>฿${this.escapeHtml(avgRound)}</b></span>
            <span style="color:#cbd5e1;">•</span>
            <span>ทุนเฉลี่ยใหม่ <b>฿${this.escapeHtml(newAvg)}</b></span>
            ${noteText ? `<span style="color:#cbd5e1;">•</span><span style="color:#334155;">📝 ${this.escapeHtml(noteText)}</span>` : ''}
          </div>
        </div>
      `;
    }

    // 4. คืนค่าจากการเบิก/เติมสต๊อกผิดพลาด
    if (raw.includes('คืนค่าจากการเบิกผิดพลาด') || raw.includes('คืนค่าจากการเติมสต๊อกผิดพลาด')) {
      const m = raw.match(/\(([^)]+)\)/);
      const detail = m ? m[1] : '';
      const isRestockRev = raw.includes('เติมสต๊อกผิดพลาด');
      return `
        <div style="display:flex; align-items:center; flex-wrap:wrap; gap:0.35rem;">
          <span class="pill-tag" style="font-size:0.73rem; font-weight:700; padding:0.12rem 0.5rem; background:#f5f3ff; color:#6d28d9; border:1px solid #ddd6fe;">
            ↩️ ${isRestockRev ? 'คืนค่าจากการเติมสต๊อกผิดพลาด' : 'คืนค่าจากการเบิกผิดพลาด'}
          </span>
          ${detail ? `<span style="font-size:0.76rem; color:${isRestockRev ? '#dc2626' : '#15803d'}; font-weight:600;">${this.escapeHtml(detail)}</span>` : ''}
        </div>
      `;
    }

    // 5. พิมพ์ปรับจำนวนจาก ... เป็น ...
    const manualAdjustMatch = raw.match(/^พิมพ์ปรับจำนวนจาก\s+(.+?)\s+เป็น\s+(.+)$/);
    if (manualAdjustMatch) {
      return `
        <div style="display:flex; align-items:center; flex-wrap:wrap; gap:0.35rem;">
          <span class="pill-tag" style="font-size:0.72rem; font-weight:700; padding:0.12rem 0.5rem; background:#f1f5f9; color:#334155; border:1px solid #cbd5e1;">
            ✏️ ปรับยอดด้วยมือ
          </span>
          <span style="font-size:0.78rem; color:#475569;">จาก <b>${this.escapeHtml(manualAdjustMatch[1])}</b> → <b>${this.escapeHtml(manualAdjustMatch[2])}</b></span>
        </div>
      `;
    }

    // 6. แก้ไขบิลซื้อ / ย้ายรายการ / หักสต๊อกจากลบบิลซื้อ
    if (raw.startsWith('แก้ไขบิลซื้อ') || raw.startsWith('ปรับแก้บิลซื้อ') || raw.startsWith('หักสต๊อกจากลบบิลซื้อ')) {
      let text = raw;
      let supHtml = '';
      const supMatch = text.match(/\[(?:ร้าน|ซื้อจาก):\s*([^\]]+)\]/);
      if (supMatch) {
        supHtml = makeSupplierPill(supMatch[1]);
        text = text.replace(supMatch[0], '').trim();
      }
      const isDelete = raw.startsWith('หักสต๊อก');
      const badgeStyle = isDelete
        ? 'background:#fef2f2; color:#dc2626; border:1px solid #fecaca;'
        : 'background:#fffbeb; color:#b45309; border:1px solid #fde68a;';
      const badgeLabel = isDelete ? '🗑️ ลบบิลซื้อ' : '📝 แก้ไขบิลซื้อ';
      const cleanedBody = text.replace(/^(แก้ไขบิลซื้อ\s*&\s*สต๊อก|ปรับแก้บิลซื้อ|หักสต๊อกจากลบบิลซื้อ)\s*/, '').trim();
      return `
        <div style="display:flex; align-items:center; flex-wrap:wrap; gap:0.35rem;">
          <span class="pill-tag" style="font-size:0.72rem; font-weight:700; padding:0.12rem 0.5rem; ${badgeStyle}">
            ${badgeLabel}
          </span>
          ${cleanedBody ? `<span style="font-size:0.76rem; color:#475569;">${linkifyText(cleanedBody)}</span>` : ''}
          ${supHtml}
        </div>
      `;
    }

    // 7. แพ็คขาย ...
    const packSellMatch = raw.match(/^(แพ็คขาย|สร้างสินค้าแพ็คขายใหม่)\s+(.+?)\s+ทุน\s+฿([\d,]+(?:\.\d+)?)\s+ขาย\s+฿([\d,]+(?:\.\d+)?)(.*)$/);
    if (packSellMatch) {
      return `
        <div style="display:flex; flex-direction:column; gap:0.25rem;">
          <div style="display:flex; align-items:center; flex-wrap:wrap; gap:0.35rem;">
            <span class="pill-tag" style="font-size:0.73rem; font-weight:700; padding:0.12rem 0.5rem; background:#fff7ed; color:#c2410c; border:1px solid #fed7aa;">
              📦 ${this.escapeHtml(packSellMatch[1])} ${this.escapeHtml(packSellMatch[2])}
            </span>
          </div>
          <div style="font-size:0.76rem; color:#64748b;">
            ทุน <b>฿${this.escapeHtml(packSellMatch[3])}</b> <span style="color:#cbd5e1;">•</span> ราคาขาย <b>฿${this.escapeHtml(packSellMatch[4])}</b>
          </div>
        </div>
      `;
    }

    // Fallback: format any URLs cleanly
    return `<div style="display:flex; align-items:center; flex-wrap:wrap; gap:0.25rem;">${linkifyText(raw)}</div>`;
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
        const sellEl = document.getElementById('stockItemSellingPrice'); if (sellEl) sellEl.value = item.sellingPrice || '';
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
      const sellEl = document.getElementById('stockItemSellingPrice'); if (sellEl) sellEl.value = '';
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
    ['stockItemQty', 'stockItemMin', 'stockItemCost', 'stockItemSellingPrice'].forEach(id => {
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
    const sellingPrice = parseFloat(document.getElementById('stockItemSellingPrice')?.value) || 0;
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
        savedItem = {
          ...oldItem,
          id, name, category, unit, qty, minQty, unitCost, sellingPrice, supplier, note
        };
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
        sellingPrice,
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

  normalizeProductName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  // ซิงค์การแก้ไขข้อมูลสต๊อกสินค้า -> รายการค่าใช้จ่าย & ต้นทุนวัตถุดิบ (Expenses)
  syncStockToExpenses(stockItem, oldItem = null, isNew = false) {
    if (!stockItem) return;
    if (!Array.isArray(this.data.expenses)) {
      this.data.expenses = [];
    }

    const stockNameNorm = this.normalizeProductName(stockItem.name);
    const oldNameNorm = oldItem ? this.normalizeProductName(oldItem.name) : '';

    // ค้นหารายการค่าใช้จ่ายที่เชื่อมโยงกับสินค้านี้
    const matchedExpenses = this.data.expenses.filter(exp => {
      if (!exp) return false;
      if (exp.stockItemId && String(exp.stockItemId) === String(stockItem.id)) return true;
      if (exp.title) {
        const expNorm = this.normalizeProductName(exp.title);
        if (stockNameNorm && expNorm === stockNameNorm) return true;
        if (oldNameNorm && expNorm === oldNameNorm) return true;
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
        const isExpBulk = (Number(exp.crateBottles) > 1) || (exp.packUnit && exp.packUnit.includes('ลัง'));
        if (!isExpBulk) {
          exp.packUnit = stockItem.unit || exp.packUnit;
        }
        if (stockItem.supplier !== undefined) exp.supplier = stockItem.supplier;
        if (stockItem.minQty !== undefined) exp.minQty = stockItem.minQty;

        // หากเป็นการแก้ไขจำนวนคงเหลือในสต๊อก (และเป็นบิลที่ผูกกัน)
        if (isQtyChanged && stockItem.qty >= 0) {
          // หากมีบิลเดียว หรือจำนวนเดิมตรงกัน ให้ปรับจำนวนรับเข้า/ขนาดแพ็คตามสต๊อก
          if (matchedExpenses.length === 1 || Number(exp.packSize) === Number(oldItem.qty)) {
            if (isExpBulk) {
              const crateCap = Number(exp.crateBottles) || 12;
              exp.packSize = parseFloat((stockItem.qty / crateCap).toFixed(2));
              exp.qtyDesc = `${exp.packSize} ${exp.packUnit} (${stockItem.qty} ${stockItem.unit})`;
            } else {
              exp.packSize = stockItem.qty;
              exp.packUnit = stockItem.unit;
              exp.qtyDesc = `${stockItem.qty} ${stockItem.unit}`;
            }
          }
        }

        // ปรับยอดเงินรวม amount ตามราคาต่อหน่วยใหม่
        const packSize = Number(exp.packSize) || 1;
        const crateCap = isExpBulk ? (Number(exp.crateBottles) || 12) : 1;
        exp.amount = parseFloat((stockItem.unitCost * packSize * crateCap).toFixed(2));
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

    const expTitleNorm = this.normalizeProductName(exp.title);
    let match = this.data.stockItems.find(s => {
      if (!s || !s.name) return false;
      if (exp.stockItemId && String(s.id) === String(exp.stockItemId)) return true;
      return this.normalizeProductName(s.name) === expTitleNorm;
    });

    const pricing = this.getExpenseUnitPricing(exp);
    const isBulk = pricing ? pricing.isBulk : false;
    const rawPackSize = pricing ? pricing.rawPackSize : (Number(exp.packSize) || 1);
    const crateBottles = pricing ? pricing.itemsPerBulk : 1;
    // เก็บสต๊อกเป็นชิ้นย่อย (ขวด/ใบ/ชิ้น) เมื่อเป็นหน่วยบรรจุรวม (ลัง/แพ็ค/กล่อง)
    const stockQty = isBulk ? (rawPackSize * crateBottles) : rawPackSize;
    const stockUnit = pricing ? pricing.pieceName : (exp.packUnit || 'หน่วย');
    const unitCost = pricing ? pricing.costPerPiece : (rawPackSize > 0 ? (Number(exp.amount) / rawPackSize) : Number(exp.amount));

    const minThreshold = (exp.minQty !== undefined && exp.minQty !== null && exp.minQty !== '')
      ? Number(exp.minQty)
      : Math.max(1, Math.round(stockQty * 0.25));

    if (match) {
      // มีสินค้าอยู่แล้ว -> เติมจำนวนคงเหลือเพิ่มขึ้น และอัปเดตราคาต้นทุนเฉลี่ย
      const oldQty = Number(match.qty) || 0;
      const newQty = oldQty + stockQty;
      match.qty = newQty;
      // คำนวณต้นทุนเฉลี่ยถ่วงน้ำหนักหากมีของเดิมอยู่
      if (oldQty > 0 && match.unitCost > 0) {
        const totalCostSum = (oldQty * Number(match.unitCost)) + (stockQty * unitCost);
        match.unitCost = parseFloat((totalCostSum / newQty).toFixed(4));
      } else {
        match.unitCost = parseFloat(unitCost.toFixed(4));
      }
      match.unit = stockUnit;
      if (isBulk && crateBottles > 1) {
        match.crateBottles = crateBottles;
        match.rawUnit = exp.packUnit || 'ลัง';
      }
      if (exp.netWeight) match.netWeight = exp.netWeight;
      if (exp.netUnit) match.netUnit = exp.netUnit;
      match.minQty = minThreshold;
      if (exp.supplier) {
        match.supplier = exp.supplier;
      }

      const supText = exp.supplier ? ` [ซื้อจาก: ${exp.supplier}]` : '';
      const bulkUnit = exp.packUnit || 'ลัง';
      const logNote = (isBulk && crateBottles > 1)
        ? `รับเข้าของ ${rawPackSize} ${bulkUnit} (= ${stockQty} ${stockUnit}) จากบิลซื้อ (${this.formatThaiDate(exp.date)})${supText}`
        : `รับเข้าของ +${stockQty} ${stockUnit} จากบิลซื้อ (${this.formatThaiDate(exp.date)})${supText}`;
      this.logStockAction(match.name, 'RESTOCK', stockQty, newQty, match.unit || '', logNote, { itemId: match.id, date: exp.date, expenseId: exp.id });
      exp.stockItemId = match.id;
    } else {
      // ยังไม่มีในสต๊อก -> เพิ่มเป็นสินค้าคงคลังรายการใหม่ทันที
      const newItem = {
        id: 'stk_' + Date.now() + Math.random().toString(36).substring(2, 5),
        name: exp.title || 'สินค้าใหม่',
        category: exp.category || (isBulk ? 'STOCK' : 'INGREDIENT'),
        unit: stockUnit,
        qty: stockQty,
        minQty: minThreshold,
        unitCost: parseFloat(unitCost.toFixed(4)),
        supplier: exp.supplier || '',
        crateBottles: (isBulk && crateBottles > 1) ? crateBottles : 1,
        rawUnit: exp.packUnit || '',
        rawPackSize: rawPackSize,
        netWeight: exp.netWeight || null,
        netUnit: exp.netUnit || null,
        note: (isBulk && crateBottles > 1)
          ? `รับเข้า ${rawPackSize} ${exp.packUnit || 'ลัง'} (= ${stockQty} ${stockUnit}) จากบิลซื้อ (${this.formatThaiDate(exp.date)})`
          : `รับเข้าจากบิลซื้อ (${this.formatThaiDate(exp.date)})`
      };
      this.data.stockItems.unshift(newItem);
      const supText = exp.supplier ? ` [ซื้อจาก: ${exp.supplier}]` : '';
      this.logStockAction(newItem.name, 'RESTOCK', stockQty, stockQty, newItem.unit, `เพิ่มรายการใหม่ +${stockQty} ${stockUnit} จากบิลซื้อ (${this.formatThaiDate(exp.date)})${supText}`, { itemId: newItem.id, date: exp.date, expenseId: exp.id });
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
      const oldTitleNorm = this.normalizeProductName(oldExp.title);
      match = this.data.stockItems.find(s => {
        if (!s || !s.name) return false;
        return this.normalizeProductName(s.name) === oldTitleNorm;
      });
    }
    if (!match && updatedExp && updatedExp.title) {
      const newTitleNorm = this.normalizeProductName(updatedExp.title);
      match = this.data.stockItems.find(s => {
        if (!s || !s.name) return false;
        return this.normalizeProductName(s.name) === newTitleNorm;
      });
    }

    if (!match) {
      // หากยังไม่มีสต๊อกรายการนี้ ให้เพิ่มเข้าสต๊อกใหม่ทันที
      this.addExpenseToStock(updatedExp);
      return;
    }

    const oldPricing = this.getExpenseUnitPricing(oldExp);
    const newPricing = this.getExpenseUnitPricing(updatedExp);

    // แปลงเป็นชิ้นย่อย (ขวด/ใบ/ชิ้น) เมื่อเป็นหน่วยบรรจุรวม (ลัง/แพ็ค/กล่อง)
    const oldRawPackSize = oldPricing ? oldPricing.rawPackSize : (Number(oldExp ? oldExp.packSize : 1) || 1);
    const newRawPackSize = newPricing ? newPricing.rawPackSize : (Number(updatedExp ? updatedExp.packSize : 1) || 1);
    const oldCrateBottles = oldPricing ? oldPricing.itemsPerBulk : 1;
    const newCrateBottles = newPricing ? newPricing.itemsPerBulk : 1;
    const oldStockQty = oldRawPackSize * oldCrateBottles;
    const newStockQty = newRawPackSize * newCrateBottles;
    const diffQty = newStockQty - oldStockQty;

    const isBulk = newPricing ? newPricing.isBulk : false;
    const stockUnit = newPricing ? newPricing.pieceName : (updatedExp.packUnit || match.unit || 'หน่วย');
    const unitCost = newPricing ? newPricing.costPerPiece : (newRawPackSize > 0 ? (Number(updatedExp.amount) / newRawPackSize) : Number(updatedExp.amount));
    const minThreshold = (updatedExp.minQty !== undefined && updatedExp.minQty !== null && updatedExp.minQty !== '')
      ? Number(updatedExp.minQty)
      : Math.max(1, Math.round(newStockQty * 0.25));

    // ตรวจสอบว่ามีการเปลี่ยนชื่อไปตรงกับสต๊อกรายการอื่นหรือไม่
    const newTitleNorm = this.normalizeProductName(updatedExp.title);
    const anotherMatch = this.data.stockItems.find(s => {
      if (!s || !s.name || (match && String(s.id) === String(match.id))) return false;
      return this.normalizeProductName(s.name) === newTitleNorm;
    });

    if (anotherMatch) {
      // ผู้ใช้เปลี่ยนชื่อบิลไปตรงกับสินค้าตัวอื่นที่มีอยู่แล้ว -> ตัดยอดออกจากตัวเดิม แล้วย้ายไปบวกที่ตัวใหม่
      const prevQty = Number(match.qty) || 0;
      match.qty = Math.max(0, prevQty - oldStockQty);
      this.logStockAction(match.name, 'ADJUST', -oldStockQty, match.qty, match.unit || '', `ปรับแก้บิลซื้อ ย้ายรายการไปที่ "${anotherMatch.name}"`, { itemId: match.id, date: updatedExp.date });

      const anotherPrevQty = Number(anotherMatch.qty) || 0;
      const anotherNewQty = anotherPrevQty + newStockQty;
      anotherMatch.qty = anotherNewQty;
      anotherMatch.unitCost = parseFloat(unitCost.toFixed(4));
      anotherMatch.minQty = minThreshold;
      anotherMatch.unit = stockUnit;
      if (isBulk && newPricing.itemsPerBulk > 1) {
        anotherMatch.crateBottles = newPricing.itemsPerBulk;
        anotherMatch.rawUnit = updatedExp.packUnit;
      }
      if (updatedExp.supplier) anotherMatch.supplier = updatedExp.supplier;
      if (updatedExp.category) anotherMatch.category = updatedExp.category;

      this.logStockAction(anotherMatch.name, 'RESTOCK', newStockQty, anotherNewQty, anotherMatch.unit || '', `รับเข้าจากการแก้ไขบิลซื้อ (${this.formatThaiDate(updatedExp.date)})`, { itemId: anotherMatch.id, date: updatedExp.date });
      updatedExp.stockItemId = anotherMatch.id;
    } else {
      // รายการเดิม -> อัปเดตข้อมูลทั้งหมดตามที่แก้ไข
      const currentQty = Number(match.qty) || 0;
      const newQty = Math.max(0, currentQty + diffQty);
      match.name = updatedExp.title || match.name;
      match.qty = newQty;
      match.unitCost = parseFloat(unitCost.toFixed(4));
      match.unit = stockUnit;
      if (isBulk && newPricing.itemsPerBulk > 1) {
        match.crateBottles = newPricing.itemsPerBulk;
        match.rawUnit = updatedExp.packUnit;
      }
      if (updatedExp.netWeight) match.netWeight = updatedExp.netWeight;
      if (updatedExp.netUnit) match.netUnit = updatedExp.netUnit;
      match.category = updatedExp.category || match.category || (isBulk ? 'STOCK' : 'INGREDIENT');
      match.minQty = minThreshold;
      if (updatedExp.supplier !== undefined) {
        match.supplier = updatedExp.supplier;
      }

      const supText = updatedExp.supplier ? ` [ร้าน: ${updatedExp.supplier}]` : '';
      const diffText = diffQty !== 0 ? ` (ปรับจำนวน ${diffQty >= 0 ? '+' : ''}${diffQty} ${match.unit} คงเหลือ ${newQty})` : '';
      const crateSub = (isBulk && newPricing.itemsPerBulk > 1) ? ` [${updatedExp.packSize} ${updatedExp.packUnit} @ ${newPricing.itemsPerBulk} ${match.unit}/${updatedExp.packUnit}]` : '';
      const logNote = `แก้ไขบิลซื้อ & สต๊อก${diffText}${crateSub} ทุน ฿${match.unitCost}/${match.unit} เกณฑ์เตือน ${match.minQty}${supText}`;
      this.logStockAction(match.name, 'ADJUST', diffQty, newQty, match.unit || '', logNote, { itemId: match.id, date: updatedExp.date, expenseId: updatedExp.id });
      // อัปเดตวันที่ของ log เดิมที่ผูกกับบิลนี้ให้ตรงกับวันที่บิลล่าสุดด้วย
      if (updatedExp.id && updatedExp.date && Array.isArray(this.data.stockLogs)) {
        const newDateStr = String(updatedExp.date).substring(0, 10);
        this.data.stockLogs.forEach(l => {
          if (l && String(l.expenseId || '') === String(updatedExp.id)) {
            l.date = newDateStr;
          }
        });
      }
      updatedExp.stockItemId = match.id;
    }
  }

  // หักสต๊อกเมื่อมีการลบรายการค่าใช้จ่าย
  removeExpenseFromStock(exp) {
    if (!Array.isArray(this.data.stockItems) || !exp) return;
    const pricing = this.getExpenseUnitPricing(exp);
    const isBulk = pricing ? pricing.isBulk : false;
    const rawPackSize = pricing ? pricing.rawPackSize : (Number(exp.packSize) || 1);
    const crateBottles = pricing ? pricing.itemsPerBulk : 1;
    const qtyToRemove = isBulk ? (rawPackSize * crateBottles) : rawPackSize;
    let match = null;
    if (exp.stockItemId) {
      match = this.data.stockItems.find(s => s && String(s.id) === String(exp.stockItemId));
    }
    if (!match && exp.title) {
      const expTitleNorm = this.normalizeProductName(exp.title);
      match = this.data.stockItems.find(s => {
        if (!s || !s.name) return false;
        return this.normalizeProductName(s.name) === expTitleNorm;
      });
    }

    if (match) {
      const oldQty = Number(match.qty) || 0;
      const newQty = Math.max(0, oldQty - qtyToRemove);
      match.qty = newQty;
      this.logStockAction(match.name, 'ADJUST', -qtyToRemove, newQty, match.unit || '', `หักสต๊อกจากลบบิลซื้อ -${qtyToRemove} ${match.unit} (${this.formatThaiDate(exp.date)})`, { itemId: match.id, date: exp.date });
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
      const expTitleNorm = this.normalizeProductName(exp.title);
      let match = this.data.stockItems.find(s => {
        if (!s || !s.name) return false;
        if (exp.stockItemId && String(s.id) === String(exp.stockItemId)) return true;
        return this.normalizeProductName(s.name) === expTitleNorm;
      });

      const pricing = this.getExpenseUnitPricing(exp);
      const isBulk = pricing ? pricing.isBulk : false;
      const rawPackSize = pricing ? pricing.rawPackSize : (Number(exp.packSize) || 1);
      const crateBottles = pricing ? pricing.itemsPerBulk : 1;
      // เก็บสต๊อกเป็นชิ้นย่อย (ขวด/ใบ/ชิ้น) เมื่อเป็นหน่วยบรรจุรวม (ลัง/แพ็ค/กล่อง)
      const stockQty = isBulk ? (rawPackSize * crateBottles) : rawPackSize;
      const stockUnit = pricing ? pricing.pieceName : (exp.packUnit || 'หน่วย');
      const unitCost = pricing ? pricing.costPerPiece : (rawPackSize > 0 ? (Number(exp.amount) / rawPackSize) : Number(exp.amount));

      const effectiveMin = (exp.minQty !== undefined && exp.minQty !== null && exp.minQty !== '')
        ? Number(exp.minQty)
        : Math.max(1, Math.round(stockQty * 0.25));

      if (match) {
        match.unitCost = parseFloat(unitCost.toFixed(4));
        match.unit = stockUnit;
        if (isBulk && crateBottles > 1) {
          match.crateBottles = crateBottles;
          match.rawUnit = exp.packUnit || 'ลัง';
        }
        if (exp.netWeight) match.netWeight = exp.netWeight;
        if (exp.netUnit) match.netUnit = exp.netUnit;
        if (exp.supplier && !match.supplier) match.supplier = exp.supplier;
        if (exp.minQty !== undefined && exp.minQty !== null && exp.minQty !== '') match.minQty = Number(exp.minQty);
        if (!exp.stockItemId) exp.stockItemId = match.id;
        syncedCount++;
      } else {
        const pieceName = pricing ? pricing.pieceName : (exp.packUnit || 'ชิ้น');
        const newItem = {
          id: 'stk_' + Date.now() + Math.random().toString(36).substring(2, 5),
          name: exp.title,
          category: exp.category || (isBulk ? 'STOCK' : 'INGREDIENT'),
          unit: stockUnit,
          qty: stockQty,
          minQty: effectiveMin,
          unitCost: parseFloat(unitCost.toFixed(4)),
          supplier: exp.supplier || '',
          crateBottles: (isBulk && crateBottles > 1) ? crateBottles : 1,
          rawUnit: exp.packUnit || '',
          rawPackSize: rawPackSize,
          netWeight: exp.netWeight || null,
          netUnit: exp.netUnit || null,
          note: (isBulk && crateBottles > 1)
            ? `ซิงค์อัตโนมัติจากบิลซื้อ ${rawPackSize} ${exp.packUnit || 'ลัง'} (= ${stockQty} ${pieceName})`
            : `ซิงค์อัตโนมัติจากบิลซื้อ (${this.formatThaiDate(exp.date)})`
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

  setLowStockCategoryFilter(cat) {
    this.currentLowStockCategoryFilter = cat || 'ALL';
    document.querySelectorAll('#lowStockCategoryPills .figma-pill-filter').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.cat === this.currentLowStockCategoryFilter);
    });
    this.renderLowStockAlertView();
  }

  clearSearchInput(inputId, renderMethod) {
    const el = document.getElementById(inputId);
    if (el) {
      el.value = '';
      if (renderMethod && typeof this[renderMethod] === 'function') {
        this[renderMethod]();
      }
      el.focus();
    } else if (renderMethod && typeof this[renderMethod] === 'function') {
      this[renderMethod]();
    }
  }

  resetLowStockFilters() {
    this.currentLowStockSupplierFilter = 'ALL';
    this.currentLowStockCategoryFilter = 'ALL';
    const searchInput = document.getElementById('lowStockSearchInput');
    if (searchInput) searchInput.value = '';
    document.querySelectorAll('#lowStockCategoryPills .figma-pill-filter').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.cat === 'ALL');
    });
    this.renderLowStockAlertView();
  }

  renderLowStockAlertView() {
    const list = this.data.stockItems || [];
    const container = document.getElementById('lowStockCardsContainer');
    if (!container) return;

    if (!this.currentLowStockSupplierFilter) {
      this.currentLowStockSupplierFilter = 'ALL';
    }
    if (!this.currentLowStockCategoryFilter) {
      this.currentLowStockCategoryFilter = 'ALL';
    }

    // รวมรายการที่วิกฤต:
    // 1. สต๊อกเหลือ 0 หรือติดลบ (หมดสต๊อกเกลี้ยงร้าน ย้ายมาจากหน้าสต๊อกหลัก)
    // 2. มี minQty > 0 และ qty <= minQty (ใกล้หมดต่ำกว่าเกณฑ์)
    const lowItems = list.filter(item => {
      const qty = Number(item.qty) || 0;
      const min = Number(item.minQty) || 0;
      const isOutOfStock = qty <= 0;
      const isLow = (min > 0 && qty <= min) || isOutOfStock;
      return isLow;
    });

    // เรียงลำดับ: สินค้าที่เหลือ 0 (หมดเกลี้ยง) ขึ้นมาก่อนเป็นลำดับแรกสุด
    lowItems.sort((a, b) => {
      const aQty = Number(a.qty) || 0;
      const bQty = Number(b.qty) || 0;
      const aZero = aQty <= 0 ? 0 : 1;
      const bZero = bQty <= 0 ? 0 : 1;
      if (aZero !== bZero) return aZero - bZero;
      return a.name.localeCompare(b.name, 'th');
    });

    let totalSuggestedQty = 0;
    let totalEstBudget = 0;
    const supplierMap = {};

    lowItems.forEach(item => {
      const qty = Number(item.qty) || 0;
      const min = Number(item.minQty) || 0;
      // แนะนำสั่งซื้อ: ถ้าไม่มี minQty ให้สั่งตาม packSize หรืออย่างน้อย 1
      const defaultPack = Number(item.packSize) || ((item.unit || '').includes('ลัง') ? 24 : 1);
      const diff = Math.max(1, (min * 2) - qty, defaultPack);
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

    // Apply Supplier, Category & Search Filters to lowItems
    const searchInput = document.getElementById('lowStockSearchInput');
    const searchClearBtn = document.getElementById('lowStockSearchClearBtn');
    const searchQuery = (searchInput?.value || '').trim().toLowerCase();
    if (searchClearBtn) {
      searchClearBtn.style.display = searchQuery ? 'block' : 'none';
    }

    let displayedItems = [...lowItems];
    if (this.currentLowStockCategoryFilter && this.currentLowStockCategoryFilter !== 'ALL') {
      displayedItems = displayedItems.filter(item => item.category === this.currentLowStockCategoryFilter);
    }

    if (searchQuery) {
      const catLabels = {
        INGREDIENT: 'วัตถุดิบชงน้ำ',
        PACKAGING: 'บรรจุภัณฑ์ & แก้ว',
        FRIDGE_DRINK: 'น้ำขายในตู้',
        STOCK: 'ยกลัง/สำเร็จรูป',
        OTHER: 'ค่าใช้จ่ายอื่นๆ',
        PACK_SELL: 'ของแพ็คขาย'
      };
      displayedItems = displayedItems.filter(item => {
        const name = String(item.name || '').toLowerCase();
        const sup = String(item.supplier || '').toLowerCase();
        const parsedSup = String(this.parseSupplier(item.supplier || '').name || '').toLowerCase();
        const note = String(item.note || '').toLowerCase();
        const unit = String(item.unit || '').toLowerCase();
        const catLabel = String(catLabels[item.category] || item.category || '').toLowerCase();
        return name.includes(searchQuery) ||
          sup.includes(searchQuery) ||
          parsedSup.includes(searchQuery) ||
          note.includes(searchQuery) ||
          unit.includes(searchQuery) ||
          catLabel.includes(searchQuery);
      });
    }

    if (this.currentLowStockSupplierFilter && this.currentLowStockSupplierFilter !== 'ALL') {
      displayedItems = displayedItems.filter(item => {
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

    // Apply Sort Order (newest / oldest / critical)
    const sortOrder = document.getElementById('lowStockSortOrder')?.value || 'newest';
    if (sortOrder === 'newest') {
      displayedItems.sort((a, b) => String(b.id || '').localeCompare(String(a.id || '')));
    } else if (sortOrder === 'oldest') {
      displayedItems.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
    } // 'critical' keeps default lowItems sort (qty <= 0 first, then Thai name)

    // Bind Hero Actions
    const btnCopy = document.getElementById('btnExportShoppingList');
    if (btnCopy) {
      btnCopy.onclick = () => this.copyShoppingListToClipboard(displayedItems, supplierMap);
    }

    if (lowItems.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem; background: #f0fdf4; border: 1.5px dashed #86efac; border-radius: var(--radius-md);">
          <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">🎉</div>
          <h3 style="color: #15803d; font-weight: 800; font-size: 1.15rem;">สต๊อกสินค้าและวัตถุดิบทุกรายการยังปลอดภัยดี</h3>
          <p style="color: #166534; font-size: 0.9rem; margin-top: 0.25rem;">ไม่มีสินค้าที่หมดหรือเหลือน้อยกว่าเกณฑ์ปลอดภัยในขณะนี้</p>
          <button class="btn-fastwork mt-3" onclick="app.switchTab('stock')">กลับไปดูสต๊อกร้านค้า & วัตถุดิบ</button>
        </div>
      `;
      this.refreshLucide();
      return;
    }

    if (displayedItems.length === 0) {
      const emptyTitle = searchQuery
        ? `ไม่พบสินค้าเตือนสั่งซื้อที่ตรงกับ "${this.escapeHtml(searchInput.value.trim())}"`
        : (this.currentLowStockSupplierFilter !== 'ALL'
          ? `ไม่พบสินค้าเตือนสั่งซื้อที่ซื้อจาก "${this.escapeHtml(this.currentLowStockSupplierFilter)}"`
          : 'ไม่พบสินค้าเตือนสั่งซื้อในหมวดหมู่นี้');
      const emptySub = searchQuery
        ? 'ลองเปลี่ยนคำค้นหา หรือล้างตัวกรองเพื่อดูรายการทั้งหมด'
        : 'รายการสินค้าใกล้หมดอาจอยู่ในหมวดหมู่หรือแหล่งซื้ออื่น';
      container.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem; background: #fffbeb; border: 1.5px dashed #fcd34d; border-radius: var(--radius-md);">
          <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">🔍</div>
          <h3 style="color: #92400e; font-weight: 800; font-size: 1.15rem;">${emptyTitle}</h3>
          <p style="color: #b45309; font-size: 0.9rem; margin-top: 0.25rem;">${emptySub}</p>
          <button class="btn-fastwork mt-3" onclick="app.resetLowStockFilters()">ดูสินค้าใกล้หมดทั้งหมด (${lowItems.length} รายการ)</button>
        </div>
      `;
      this.refreshLucide();
      return;
    }

    container.innerHTML = displayedItems.map(item => {
      const currentQty = Number(item.qty) || 0;
      const minQty = Number(item.minQty) || 0;
      const unit = item.unit || 'หน่วย';
      const unitCost = Number(item.unitCost) || 0;
      const isOutOfStock = currentQty <= 0;

      // คำนวณ % คงเหลือเทียบกับ minQty (0-100)
      const ratioPct = isOutOfStock ? 0 : Math.min(100, Math.round((currentQty / Math.max(1, minQty)) * 100));
      // จำนวนแนะนำสั่งซื้อ
      const defaultPack = Number(item.packSize) || (unit.includes('ลัง') ? 24 : 1);
      const suggestedBuy = Math.max(1, (minQty * 2) - currentQty, defaultPack);
      const estCost = suggestedBuy * unitCost;

      const catLabel = item.category === 'INGREDIENT' ? 'วัตถุดิบชงน้ำ'
        : item.category === 'PACKAGING' ? 'บรรจุภัณฑ์'
          : item.category === 'FRIDGE_DRINK' ? 'น้ำขายในตู้'
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
                  ${item.crateBottles > 1 ? `<span class="pill-tag blue-tag" style="font-size:0.7rem; font-weight:700;">📦 บรรจุ ${item.crateBottles} ${this.escapeHtml(unit)}/${this.escapeHtml(item.rawUnit || 'ลัง')}</span>` : ''}
                  ${supplierBadgeHtml}
                </div>
                <div class="low-stock-item-name">${this.escapeHtml(item.name)}</div>
              </div>
              <div class="low-stock-badge-critical" style="${isOutOfStock ? 'background:#dc2626; color:#ffffff; font-weight:800;' : ''}">
                <i data-lucide="${isOutOfStock ? 'x-circle' : 'alert-triangle'}" style="width:13px;height:13px;"></i>
                <span>${isOutOfStock ? '🚨 หมดสต๊อก (เหลือ 0)' : '⚠️ ใกล้หมด'}</span>
              </div>
            </div>

            <!-- Visual Stock Meter -->
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; margin-top:0.4rem;">
              <span class="text-muted">ระดับสต๊อกปัจจุบัน:</span>
              ${isOutOfStock
          ? `<span class="font-bold" style="color:#dc2626; background:#fee2e2; padding:0.12rem 0.5rem; border-radius:4px; font-size:0.85rem;">🚨 หมดสต๊อก (0 ${this.escapeHtml(unit)})</span>`
          : `<span class="font-bold text-danger">${currentQty} / ${minQty} ${this.escapeHtml(unit)}</span>`
        }
            </div>
            <div class="low-stock-meter">
              <div class="low-stock-meter-fill" style="width: ${isOutOfStock ? 0 : Math.max(8, ratioPct)}%; ${isOutOfStock ? 'background:#ef4444;' : ''}"></div>
            </div>

            <div class="low-stock-metrics-row">
              <div>ต้นทุนเดิม: <b>${this.formatCurrency(unitCost)}</b>/${this.escapeHtml(unit)}</div>
              <div>เกณฑ์ขั้นต่ำ: <b>${minQty > 0 ? `${minQty} ${this.escapeHtml(unit)}` : 'ไม่ได้ตั้งเกณฑ์'}</b></div>
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
                
              </div>
            </div>
          </div>

          <!-- Action buttons for this specific item -->
          <div class="low-stock-card-actions" style="flex-wrap:wrap;">
            <button class="btn-fastwork-sm" style="flex:1; background:#dc2626; color:#ffffff; font-weight:700; justify-content:center;" onclick="app.quickRestockItem('${item.id}', ${suggestedBuy})">
              <i data-lucide="plus-circle"></i>
              <span>${isOutOfStock ? `เติมของเข้าสต๊อก (+${suggestedBuy})` : `กดเติมทันที (+${suggestedBuy})`}</span>
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
    this.openQuickRestockModal(itemId, addQty);
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
        const minQty = Number(item.minQty) || 0;
        const currentQty = Number(item.qty) || 0;
        const defaultPack = Number(item.packSize) || ((item.unit || '').includes('ลัง') ? 24 : 1);
        const suggestedBuy = Math.max(1, (minQty * 2) - currentQty, defaultPack);
        const est = suggestedBuy * (Number(item.unitCost) || 0);
        totalEst += est;
        const linkNote = parsed.isUrl ? ` [ลิ้งก์: ${parsed.url}]` : '';
        const statusNote = currentQty <= 0 ? '🚨 หมดสต๊อก 0' : `เหลือในร้าน: ${currentQty}`;
        text += `  • ${item.name} สั่งเพิ่ม: ${suggestedBuy} ${item.unit || ''} (${statusNote})${linkNote}\n`;
      });
    });

    text += `\n=========================\n💰 ประมาณการงบรวมทั้งหมด: ฿${totalEst.toLocaleString()}\n(ส่งจากระบบสต๊อกอัตโนมัติ)`;

    navigator.clipboard.writeText(text).then(() => {
      this.showToast('คัดลอกรายการสั่งซื้อพร้อมลิ้งก์ (สำหรับส่ง LINE) เรียบร้อย! 📋', 'success');
    }).catch(() => {
      prompt('คัดลอกรายการสั่งซื้อ:', text);
    });
  }


  // =========================================================================
  // 📦 PACK SELL - แพ็คขาย
  // =========================================================================

  initPackSell() {
    if (!Array.isArray(this.selectedPackSellMats)) this.selectedPackSellMats = [];
    if (!Array.isArray(this.selectedPackSellPkgs)) this.selectedPackSellPkgs = [];

    const qtyInput = document.getElementById('packSellQty');
    const priceInput = document.getElementById('packSellPrice');
    const btnSave = document.getElementById('btnSavePackSellToStock');

    if (qtyInput) qtyInput.addEventListener('input', () => this.calculatePackSell());
    if (priceInput) priceInput.addEventListener('input', () => this.calculatePackSell());
    if (btnSave) btnSave.addEventListener('click', () => this.savePackSellToStock());
    this.renderPackSellHistory();
  }

  getPackSellAvailableExpenses(kind) {
    const available = (this.data.expenses || [])
      .filter(e => {
        if (!e) return false;
        if (kind === 'PACKAGING') return e.category === 'PACKAGING';
        return e.category !== 'FRIDGE_DRINK' && e.category !== 'PACKAGING';
      })
      .filter(exp => this.isExpenseAvailableForSelection(exp));

    const sorted = [...available].sort((a, b) => {
      const dateCmp = String(b.date || '').localeCompare(String(a.date || ''));
      if (dateCmp !== 0) return dateCmp;
      return String(b.id || '').localeCompare(String(a.id || ''));
    });

    const seen = new Set();
    const deduped = [];
    sorted.forEach(exp => {
      const key = `name_${this.normalizeProductName(exp.title)}`;
      if (seen.has(key)) return;
      seen.add(key);
      deduped.push(exp);
    });
    return deduped;
  }

  populatePackSellDropdowns() {
    // Refresh selected items display if needed
    this.renderPackSellSelectedSummary('MATERIAL');
    this.renderPackSellSelectedSummary('PACKAGING');
  }

  openPackSellPickerModal(kind) {
    const modal = document.getElementById('packSellPickerModal');
    if (!modal) return;
    this._packSellPickerKind = kind;
    const currentList = kind === 'PACKAGING' ? (this.selectedPackSellPkgs || []) : (this.selectedPackSellMats || []);
    this._packSellPickerDraftIds = new Set(currentList.map(x => String(x.exp.id)));

    const titleEl = document.getElementById('packSellPickerTitle');
    const iconWrap = document.getElementById('packSellPickerIconWrap');
    const searchEl = document.getElementById('packSellPickerSearch');
    if (titleEl) {
      titleEl.textContent = kind === 'PACKAGING' ? 'เลือกบรรจุภัณฑ์' : 'เลือกวัตถุดิบแพ็คขาย';
    }
    if (iconWrap) {
      iconWrap.style.background = kind === 'PACKAGING' ? '#fef3c7' : '#eff6ff';
      iconWrap.style.color = kind === 'PACKAGING' ? '#d97706' : 'var(--primary)';
    }
    if (searchEl) searchEl.value = '';

    this.renderPackSellPickerList();
    modal.classList.add('active');
    this.refreshLucide();
  }

  renderPackSellPickerList() {
    const listEl = document.getElementById('packSellPickerList');
    const countEl = document.getElementById('packSellPickerSelectedCount');
    if (!listEl) return;

    const kind = this._packSellPickerKind || 'MATERIAL';
    const q = (document.getElementById('packSellPickerSearch')?.value || '').trim().toLowerCase();
    const items = this.getPackSellAvailableExpenses(kind).filter(exp => {
      if (!q) return true;
      return String(exp.title || '').toLowerCase().includes(q);
    });

    if (countEl) {
      countEl.textContent = `เลือกแล้ว ${this._packSellPickerDraftIds?.size || 0} รายการ`;
    }

    if (items.length === 0) {
      listEl.innerHTML = `<div style="text-align:center; padding:1.5rem; color:#94a3b8; font-size:0.85rem;">ไม่พบรายการที่พร้อมใช้งาน</div>`;
      return;
    }

    listEl.innerHTML = items.map(exp => {
      const isChecked = this._packSellPickerDraftIds.has(String(exp.id));
      const pricing = this.getExpenseUnitPricing(exp);
      const totalCost = Number(exp.amount) || 0;
      const pSize = Number(exp.packSize) || 1;
      const costPerPiece = pricing ? pricing.costPerPiece : (totalCost / pSize);
      const pieceName = pricing ? pricing.pieceName : (exp.packUnit || 'ชิ้น');
      const subText = kind === 'PACKAGING'
        ? `ต้นทุนต่อ${pieceName}: ฿${costPerPiece.toFixed(2)}`
        : `ยอดรวมบิล: ฿${totalCost.toFixed(2)} (฿${costPerPiece.toFixed(2)}/${pieceName})`;

      return `
      <div onclick="app.togglePackSellPickerItem('${exp.id}')"
        style="display:flex; align-items:center; gap:0.7rem; padding:0.65rem 0.8rem; border-radius:10px; border:1.5px solid ${isChecked ? 'var(--primary)' : '#e2e8f0'}; background:${isChecked ? '#eff6ff' : '#ffffff'}; cursor:pointer; transition:all 0.15s;">
        <input type="checkbox" ${isChecked ? 'checked' : ''} onclick="event.stopPropagation(); app.togglePackSellPickerItem('${exp.id}')" style="width:17px; height:17px; accent-color:var(--primary); cursor:pointer;">
        <div style="flex:1; min-width:0;">
          <div style="font-weight:700; font-size:0.88rem; color:#1e293b;">${this.escapeHtml(exp.title || 'ไม่ระบุ')}</div>
          <div style="font-size:0.76rem; color:#64748b; margin-top:2px;">${this.escapeHtml(subText)}</div>
        </div>
        <span class="pill-tag ${isChecked ? 'blue-tag' : ''}" style="font-size:0.74rem; font-weight:700; ${isChecked ? '' : 'background:#f1f5f9; color:#475569;'}">
          ฿${(kind === 'PACKAGING' ? costPerPiece : totalCost).toFixed(2)}
        </span>
      </div>
    `;
    }).join('');
  }

  togglePackSellPickerItem(expId) {
    if (!this._packSellPickerDraftIds) this._packSellPickerDraftIds = new Set();
    const key = String(expId);
    if (this._packSellPickerDraftIds.has(key)) {
      this._packSellPickerDraftIds.delete(key);
    } else {
      this._packSellPickerDraftIds.add(key);
    }
    this.renderPackSellPickerList();
  }

  clearPackSellPickerDraft() {
    this._packSellPickerDraftIds = new Set();
    this.renderPackSellPickerList();
  }

  confirmPackSellPickerModal() {
    const kind = this._packSellPickerKind || 'MATERIAL';
    const available = this.getPackSellAvailableExpenses(kind);
    const picked = available.filter(exp => this._packSellPickerDraftIds.has(String(exp.id)));

    if (kind === 'PACKAGING') {
      this.selectedPackSellPkgs = picked.map(exp => {
        const pricing = this.getExpenseUnitPricing(exp);
        const totalCost = Number(exp.amount) || 0;
        const pSize = Number(exp.packSize) || 1;
        const costPerPiece = pricing ? pricing.costPerPiece : (totalCost / pSize);
        const pieceName = pricing ? pricing.pieceName : (exp.packUnit || 'ชิ้น');
        return { exp, pricing, costPerPiece, pieceName };
      });
    } else {
      this.selectedPackSellMats = picked.map(exp => {
        const pricing = this.getExpenseUnitPricing(exp);
        const totalCost = Number(exp.amount) || 0;
        const pSize = Number(exp.packSize) || 1;
        const pUnit = exp.packUnit || 'หน่วย';
        const costPerPiece = pricing ? pricing.costPerPiece : (totalCost / pSize);
        const pieceName = pricing ? pricing.pieceName : pUnit;
        return { exp, pricing, totalCost, costPerPiece, pieceName, pSize, pUnit };
      });
    }

    this.renderPackSellSelectedSummary(kind);
    document.getElementById('packSellPickerModal')?.classList.remove('active');
    this.calculatePackSell();
  }

  removePackSellSelectedItem(kind, expId) {
    if (kind === 'PACKAGING') {
      this.selectedPackSellPkgs = (this.selectedPackSellPkgs || []).filter(p => String(p.exp.id) !== String(expId));
    } else {
      this.selectedPackSellMats = (this.selectedPackSellMats || []).filter(m => String(m.exp.id) !== String(expId));
    }
    this.renderPackSellSelectedSummary(kind);
    this.calculatePackSell();
  }

  renderPackSellSelectedSummary(kind) {
    const isPkg = kind === 'PACKAGING';
    const list = isPkg ? (this.selectedPackSellPkgs || []) : (this.selectedPackSellMats || []);
    const infoBox = document.getElementById(isPkg ? 'packSellPackagingInfo' : 'packSellMaterialInfo');
    const countBadge = document.getElementById(isPkg ? 'packSellPkgCountBadge' : 'packSellMatCountBadge');
    if (countBadge) countBadge.textContent = `${list.length} รายการ`;
    if (!infoBox) return;

    if (list.length === 0) {
      infoBox.style.display = 'none';
      infoBox.innerHTML = '';
      return;
    }

    const totalSum = isPkg
      ? list.reduce((s, p) => s + p.costPerPiece, 0)
      : list.reduce((s, m) => s + m.totalCost, 0);

    const bg = isPkg ? '#fefce8' : '#eff6ff';
    const border = isPkg ? '#fde68a' : '#bfdbfe';
    const accent = isPkg ? '#b45309' : '#1d4ed8';

    infoBox.style.display = 'block';
    infoBox.innerHTML = `
    <div style="padding:0.65rem 0.75rem; background:${bg}; border-radius:10px; border:1px solid ${border}; display:flex; flex-direction:column; gap:0.4rem;">
      ${list.map(item => `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem; background:#ffffff; padding:0.35rem 0.55rem; border-radius:7px; border:1px solid ${border}; font-size:0.82rem;">
          <span style="font-weight:700; color:#1e293b; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this.escapeHtml(item.exp.title)}</span>
          <div style="display:flex; align-items:center; gap:0.45rem; flex-shrink:0;">
            <span style="font-weight:700; color:${accent};">฿${(isPkg ? item.costPerPiece : item.totalCost).toFixed(2)}${isPkg ? `/${item.pieceName}` : ''}</span>
            <button type="button" onclick="app.removePackSellSelectedItem('${kind}', '${item.exp.id}')" title="นำออก" style="background:none; border:none; color:#ef4444; cursor:pointer; font-weight:800; font-size:0.9rem; line-height:1; padding:0 2px;">&times;</button>
          </div>
        </div>
      `).join('')}
      <div style="font-size:0.78rem; font-weight:700; color:${accent}; text-align:right; padding-top:2px;">
        ${isPkg ? `รวมต้นทุนบรรจุภัณฑ์/ชิ้น: ฿${totalSum.toFixed(2)}` : `รวมต้นทุนวัตถุดิบทั้งหมด: ฿${totalSum.toFixed(2)}`}
      </div>
    </div>
  `;
  }

  calculatePackSell() {
    const resultSection = document.getElementById('packSellResultSection');
    const emptySection = document.getElementById('packSellResultEmpty');
    const qty = parseInt(document.getElementById('packSellQty')?.value) || 0;
    const price = parseFloat(document.getElementById('packSellPrice')?.value) || 0;
    const mats = this.selectedPackSellMats || [];
    const pkgs = this.selectedPackSellPkgs || [];

    if (mats.length === 0 || qty <= 0 || price <= 0) {
      if (resultSection) resultSection.style.display = 'none';
      if (emptySection) emptySection.style.display = 'flex';
      return;
    }

    const totalMatCost = mats.reduce((s, m) => s + m.totalCost, 0);
    const matCostPer = totalMatCost / qty;
    const pkgCostPer = pkgs.reduce((s, p) => s + p.costPerPiece, 0);
    const totalCostPer = matCostPer + pkgCostPer;
    const totalRevenue = price * qty;
    const profitPer = price - totalCostPer;
    const totalProfit = profitPer * qty;

    if (emptySection) emptySection.style.display = 'none';
    if (resultSection) resultSection.style.display = 'block';

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = `฿${val.toFixed(2)}`; };
    setEl('psResMaterialCostPer', matCostPer);
    setEl('psResPackagingCostPer', pkgCostPer);
    setEl('psResTotalCostPer', totalCostPer);
    setEl('psResSellPricePer', price);
    setEl('psResTotalRevenue', totalRevenue);
    setEl('psResProfitPer', profitPer);
    setEl('psResTotalProfit', totalProfit);

    // Summary banner
    const banner = document.getElementById('packSellSummaryBanner');
    if (banner) {
      const matName = mats.map(m => m.exp.title).join(' + ') || 'วัตถุดิบ';
      const pkgName = pkgs.length > 0 ? pkgs.map(p => p.exp.title).join(' + ') : '-';
      const profitClass = totalProfit >= 0 ? 'color:#16a34a;' : 'color:#dc2626;';
      banner.innerHTML = `
        <div style="padding:0.75rem 1rem; background:linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%); border-radius:10px; border:1px solid #bbf7d0; font-size:0.85rem; line-height:1.6;">
          <div style="font-weight:700; margin-bottom:0.3rem;">📋 สรุป: ${this.escapeHtml(matName)} แพ็คใส่ ${this.escapeHtml(pkgName)}</div>
          <div>จำนวน <strong>${qty}</strong> ชิ้น × ขายชิ้นละ <strong>฿${price.toFixed(2)}</strong></div>
          <div>ต้นทุนรวมต่อชิ้น: <strong style="color:#dc2626;">฿${totalCostPer.toFixed(2)}</strong> | กำไรต่อชิ้น: <strong style="${profitClass}">฿${profitPer.toFixed(2)}</strong></div>
          <div style="margin-top:0.3rem; font-weight:700; font-size:1rem; ${profitClass}">🎯 กำไรรวม: ฿${totalProfit.toFixed(2)}</div>
        </div>
      `;
    }

    // Store for save
    this.packSellCalcResult = {
      matIds: mats.map(m => String(m.exp.id)),
      pkgIds: pkgs.map(p => String(p.exp.id)),
      matName: mats.map(m => m.exp.title).join(' + ') || 'วัตถุดิบ',
      pkgName: pkgs.map(p => p.exp.title).join(' + '),
      qty, price, matCostPer, pkgCostPer, totalCostPer, totalRevenue, profitPer, totalProfit
    };
  }

  savePackSellToStock() {
    if (!this.packSellCalcResult || this.packSellCalcResult.qty <= 0) {
      this.showToast('กรุณากรอกข้อมูลให้ครบก่อนบันทึก', 'error');
      return;
    }

    const r = this.packSellCalcResult;
    const productName = `${r.matName} (แพ็คขาย${r.pkgName ? ' ใส่' + r.pkgName : ''})`;

    if (!Array.isArray(this.data.stockItems)) this.data.stockItems = [];
    if (!Array.isArray(this.data.stockLogs)) this.data.stockLogs = [];
    if (!Array.isArray(this.data.packSellLogs)) this.data.packSellLogs = [];

    const isEditing = Boolean(this.editingPackSellLogId);
    let oldLogIdx = -1;
    let oldLog = null;
    if (isEditing) {
      oldLogIdx = this.data.packSellLogs.findIndex(l => l && l.id === this.editingPackSellLogId);
      if (oldLogIdx !== -1) {
        oldLog = this.data.packSellLogs[oldLogIdx];
        if (oldLog.stockItemId) {
          const prevStk = this.data.stockItems.find(s => s && String(s.id) === String(oldLog.stockItemId));
          if (prevStk) {
            prevStk.qty = Math.max(0, (Number(prevStk.qty) || 0) - (Number(oldLog.qty) || 0));
          }
        }
      }
    }

    const existing = this.data.stockItems.find(s => s.name && s.name.toLowerCase() === productName.toLowerCase());
    let savedStockId = null;

    if (existing) {
      const oldQty = Number(existing.qty) || 0;
      existing.qty = oldQty + r.qty;
      existing.unitCost = parseFloat(r.totalCostPer.toFixed(2));
      existing.sellingPrice = r.price;
      savedStockId = existing.id;
      this.logStockAction(existing.name, 'RESTOCK', r.qty, existing.qty, existing.unit || 'ชิ้น',
        `${isEditing ? 'แก้ไข' : ''}แพ็คขาย +${r.qty} ชิ้น ทุน ฿${r.totalCostPer.toFixed(2)} ขาย ฿${r.price}`,
        { itemId: existing.id }
      );
    } else {
      const newItem = {
        id: 'stk_' + Date.now() + Math.random().toString(36).substring(2, 5),
        name: productName,
        category: 'PACK_SELL',
        unit: 'ชิ้น',
        qty: r.qty,
        minQty: Math.max(1, Math.round(r.qty * 0.25)),
        unitCost: parseFloat(r.totalCostPer.toFixed(2)),
        sellingPrice: r.price,
        supplier: '',
        note: `แพ็คจาก ${r.matName}${r.pkgName ? ' + ' + r.pkgName : ''}`
      };
      this.data.stockItems.push(newItem);
      savedStockId = newItem.id;
      this.logStockAction(newItem.name, 'RESTOCK', r.qty, r.qty, 'ชิ้น',
        `สร้างสินค้าแพ็คขายใหม่ ${r.qty} ชิ้น ทุน ฿${r.totalCostPer.toFixed(2)} ขาย ฿${r.price}`,
        { itemId: newItem.id }
      );
    }

    const now = new Date();
    if (isEditing && oldLogIdx !== -1 && oldLog) {
      this.data.packSellLogs[oldLogIdx] = {
        ...oldLog,
        stockItemId: savedStockId,
        productName,
        matIds: r.matIds,
        pkgIds: r.pkgIds,
        matName: r.matName,
        pkgName: r.pkgName,
        qty: r.qty,
        price: r.price,
        matCostPer: r.matCostPer,
        pkgCostPer: r.pkgCostPer,
        totalCostPer: r.totalCostPer,
        totalRevenue: r.totalRevenue,
        profitPer: r.profitPer,
        totalProfit: r.totalProfit
      };
      this.showToast(`✅ อัปเดตประวัติ "${productName}" (${r.qty} ชิ้น) เรียบร้อยแล้ว`, 'success');
    } else {
      this.data.packSellLogs.unshift({
        id: 'psl_' + Date.now() + Math.random().toString(36).substring(2, 5),
        date: this.formatDate(now),
        time: now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
        timestamp: Date.now(),
        stockItemId: savedStockId,
        productName,
        matIds: r.matIds,
        pkgIds: r.pkgIds,
        matName: r.matName,
        pkgName: r.pkgName,
        qty: r.qty,
        price: r.price,
        matCostPer: r.matCostPer,
        pkgCostPer: r.pkgCostPer,
        totalCostPer: r.totalCostPer,
        totalRevenue: r.totalRevenue,
        profitPer: r.profitPer,
        totalProfit: r.totalProfit
      });
      this.showToast(`บันทึก "${productName}" +${r.qty} ชิ้น เข้าสต๊อกสำเร็จ!`, 'success');
    }

    this.editingPackSellLogId = null;
    const btnText = document.getElementById('btnSavePackSellToStockText');
    const cancelBtn = document.getElementById('btnCancelEditPackSellLog');
    if (btnText) btnText.textContent = 'บันทึกเข้าสต๊อกร้านค้า';
    if (cancelBtn) cancelBtn.style.display = 'none';

    this.saveData();
    this.renderPackSellHistory();
    this.renderStock();
    this.renderLowStockAlertView();
    this.renderDashboard();
  }

  renderPackSellHistory() {
    const listEl = document.getElementById('packSellHistoryList');
    const badgeEl = document.getElementById('packSellHistoryCount');
    if (!listEl) return;

    if (!Array.isArray(this.data.packSellLogs)) {
      this.data.packSellLogs = [];
    }
    const logs = this.data.packSellLogs;
    if (badgeEl) badgeEl.textContent = `${logs.length} รายการ`;

    if (logs.length === 0) {
      listEl.innerHTML = `
      <div class="figma-tx-empty" style="padding:1.5rem 1rem; grid-column:1 / -1;">
        <div class="figma-tx-empty-icon"><i data-lucide="inbox"></i></div>
        <div class="figma-tx-empty-title">ยังไม่มีประวัติของแพ็คขาย</div>
        <div class="figma-tx-empty-desc">คำนวณแล้วกด "บันทึกเข้าสต๊อกร้านค้า" เพื่อเก็บประวัติที่นี่</div>
      </div>
    `;
      this.refreshLucide();
      return;
    }

    listEl.innerHTML = logs.map(log => {
      const totalCostAll = (Number(log.totalCostPer) || 0) * (Number(log.qty) || 0);
      const totalProfit = Number(log.totalProfit) || 0;
      const isProfit = totalProfit >= 0;
      const profitColor = isProfit ? 'color:#15803d;' : 'color:#dc2626;';

      return `
      <div class="drink-sales-history-card dsh-card-clean">
        <div class="dsh-header">
          <div class="dsh-date">
            <i data-lucide="calendar" style="width:14px;height:14px;"></i>
            <span>${this.formatThaiDate(log.date)} · ${log.time || ''} น.</span>
          </div>
          <div style="display:flex; align-items:center; gap:0.35rem;">
            <span class="dsh-total-pill">รวม <b>${log.qty}</b> ชิ้น</span>
            <button type="button" class="icon-btn" title="แก้ไขรายการนี้" onclick="app.editPackSellLog('${log.id}')" style="width:28px;height:28px;color:#2563eb;">
              <i data-lucide="edit-3" style="width:14px;height:14px;"></i>
            </button>
            <button type="button" class="icon-btn text-danger" title="ลบรายการนี้" onclick="app.deletePackSellLog('${log.id}')" style="width:28px;height:28px;color:#ef4444;">
              <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
            </button>
          </div>
        </div>

        <div style="font-weight:700; font-size:0.9rem; color:#1e293b;">
          📦 ${this.escapeHtml(log.productName || log.matName || 'แพ็คขาย')}
        </div>

        <div class="dsh-sizes-wrap">
          <div class="dsh-size-chip">
            <span class="dsh-size-tag">วัตถุดิบ</span>
            <span class="dsh-size-qty">${this.escapeHtml(log.matName || '-')}</span>
          </div>
          ${log.pkgName ? `
            <div class="dsh-size-chip">
              <span class="dsh-size-tag" style="color:#d97706;">บรรจุภัณฑ์</span>
              <span class="dsh-size-qty">${this.escapeHtml(log.pkgName)}</span>
            </div>
          ` : ''}
        </div>

        <div style="font-size:0.76rem; color:#64748b;">
          ทุน/ชิ้น <b>฿${Number(log.totalCostPer || 0).toFixed(2)}</b> · ราคาขาย/ชิ้น <b>฿${Number(log.price || 0).toFixed(2)}</b>
        </div>

        <div class="dsh-finance-grid">
          <div class="dsh-fin-item">
            <span class="dsh-fin-lbl">รายรับรวม</span>
            <span class="dsh-fin-val text-primary">฿${Number(log.totalRevenue || 0).toLocaleString()}</span>
          </div>
          <div class="dsh-fin-item">
            <span class="dsh-fin-lbl">ต้นทุนรวม</span>
            <span class="dsh-fin-val" style="color:#dc2626;">฿${totalCostAll.toFixed(2)}</span>
          </div>
          <div class="dsh-fin-item highlight">
            <span class="dsh-fin-lbl">คาดการณ์กำไร</span>
            <span class="dsh-fin-val" style="${profitColor}">
              ${isProfit ? '+' : ''}฿${totalProfit.toFixed(2)}
            </span>
          </div>
        </div>
      </div>
    `;
    }).join('');

    this.refreshLucide();
  }

  editPackSellLog(logId) {
    const log = (this.data.packSellLogs || []).find(l => l && l.id === logId);
    if (!log) return;

    this.editingPackSellLogId = log.id;
    const allExpenses = this.data.expenses || [];

    // Restore selected materials
    const matIds = Array.isArray(log.matIds) ? log.matIds.map(String) : [];
    this.selectedPackSellMats = matIds
      .map(id => allExpenses.find(e => e && String(e.id) === id))
      .filter(Boolean)
      .map(exp => {
        const pricing = this.getExpenseUnitPricing(exp);
        const totalCost = Number(exp.amount) || 0;
        const pSize = Number(exp.packSize) || 1;
        const pUnit = exp.packUnit || 'หน่วย';
        const costPerPiece = pricing ? pricing.costPerPiece : (totalCost / pSize);
        const pieceName = pricing ? pricing.pieceName : pUnit;
        return { exp, pricing, totalCost, costPerPiece, pieceName, pSize, pUnit };
      });

    // Restore selected packagings
    const pkgIds = Array.isArray(log.pkgIds) ? log.pkgIds.map(String) : [];
    this.selectedPackSellPkgs = pkgIds
      .map(id => allExpenses.find(e => e && String(e.id) === id))
      .filter(Boolean)
      .map(exp => {
        const pricing = this.getExpenseUnitPricing(exp);
        const totalCost = Number(exp.amount) || 0;
        const pSize = Number(exp.packSize) || 1;
        const costPerPiece = pricing ? pricing.costPerPiece : (totalCost / pSize);
        const pieceName = pricing ? pricing.pieceName : (exp.packUnit || 'ชิ้น');
        return { exp, pricing, costPerPiece, pieceName };
      });

    this.renderPackSellSelectedSummary('MATERIAL');
    this.renderPackSellSelectedSummary('PACKAGING');

    const qtyEl = document.getElementById('packSellQty');
    const priceEl = document.getElementById('packSellPrice');
    if (qtyEl) qtyEl.value = log.qty || '';
    if (priceEl) priceEl.value = log.price || '';

    this.calculatePackSell();

    const btnText = document.getElementById('btnSavePackSellToStockText');
    const cancelBtn = document.getElementById('btnCancelEditPackSellLog');
    if (btnText) btnText.textContent = 'อัปเดตประวัติ & สต๊อก';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';

    document.getElementById('tab-pack-sell')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.showToast(`📝 โหลดข้อมูล "${log.productName || log.matName}" สำหรับแก้ไขแล้ว`, 'info');
  }

  cancelEditPackSellLog() {
    this.editingPackSellLogId = null;
    const btnText = document.getElementById('btnSavePackSellToStockText');
    const cancelBtn = document.getElementById('btnCancelEditPackSellLog');
    if (btnText) btnText.textContent = 'บันทึกเข้าสต๊อกร้านค้า';
    if (cancelBtn) cancelBtn.style.display = 'none';
    this.showToast('ยกเลิกการแก้ไขแล้ว', 'info');
  }

  deletePackSellLog(logId) {
    if (!confirm('คุณต้องการลบประวัติของแพ็คขายรายการนี้ใช่หรือไม่? (ยอดสต๊อกที่เติมจากรายการนี้จะถูกหักออก)')) return;
    if (!Array.isArray(this.data.packSellLogs)) return;
    const target = this.data.packSellLogs.find(l => l && l.id === logId);
    if (target && target.stockItemId && Array.isArray(this.data.stockItems)) {
      const stk = this.data.stockItems.find(s => s && String(s.id) === String(target.stockItemId));
      if (stk) {
        stk.qty = Math.max(0, (Number(stk.qty) || 0) - (Number(target.qty) || 0));
      }
    }
    if (this.editingPackSellLogId === logId) {
      this.cancelEditPackSellLog();
    }
    this.data.packSellLogs = this.data.packSellLogs.filter(l => l && l.id !== logId);
    this.saveData();
    this.renderPackSellHistory();
    this.renderStock();
    this.renderLowStockAlertView();
    this.renderDashboard();
    this.showToast('ลบประวัติของแพ็คขายเรียบร้อยแล้ว', 'info');
  }

  // =========================================================================
  // 💰 DRINK SALES - คำนวณการขายน้ำชง
  // =========================================================================

  populateDrinkSalesRecipes() {
    this.renderDsInlineRecipes();
  }

  initDrinkSales() {
    // Cup size config: persist in this.data so custom sizes, variants & prices are saved
    const defaultSizes = [
      { id: '10', oz: 10, label: '', mlDefault: 150, priceDefault: 5 },
      { id: '16', oz: 16, label: '', mlDefault: 250, priceDefault: 10 },
      { id: '28', oz: 28, label: '', mlDefault: 400, priceDefault: 20 }
    ];
    if (!Array.isArray(this.data.dsCupSizes) || this.data.dsCupSizes.length === 0) {
      this.data.dsCupSizes = defaultSizes;
    }
    this.dsCupSizes = this.data.dsCupSizes;

    if (!this.data.dsPackagingConfig || typeof this.data.dsPackagingConfig !== 'object') {
      this.data.dsPackagingConfig = {};
    }
    this.dsCupSizes.forEach(s => {
      if (!s.id) s.id = String(s.oz);
      if (s.label === undefined) s.label = '';
      if (!this.data.dsPackagingConfig[s.id]) {
        this.data.dsPackagingConfig[s.id] = { bundled: false, bundledExpId: '', cupExpId: '', lidExpId: '', strawExpId: '', mlPerCup: s.mlDefault };
      }
    });
    this.dsPackagingConfig = this.data.dsPackagingConfig;

    // Selected recipe IDs
    if (!this.drinkSalesSelectedRecipeIds) this.drinkSalesSelectedRecipeIds = new Set();

    // Render cup size config cards & cup count rows
    this.renderDsCupSizeCards();
    this.renderDsCupCountRows();
    // Render inline recipe list
    this.renderDsInlineRecipes();

    // Bind calculate button
    const btnCalc = document.getElementById('btnDrinkSalesCalculate');
    if (btnCalc && !btnCalc._bound) {
      btnCalc._bound = true;
      btnCalc.addEventListener('click', () => this.calculateDrinkSalesProfit());
    }

    // Default save date to today
    const saveDateInput = document.getElementById('drinkSalesSaveDate');
    if (saveDateInput && !saveDateInput.value) {
      saveDateInput.value = this.formatDate(new Date());
    }

    // Bind save log button
    const btnSave = document.getElementById('btnSaveDrinkSalesLog');
    if (btnSave && !btnSave._bound) {
      btnSave._bound = true;
      btnSave.addEventListener('click', () => this.saveDrinkSalesLog());
    }

    this.renderDrinkSalesHistory();
  }

  // ═══ Get PACKAGING expenses for dropdown options (latest per product only, excluding out-of-stock/no-alert) ═══
  getDsPackagingOptions() {
    const available = (this.data.expenses || [])
      .filter(e => e && e.category === 'PACKAGING')
      .filter(exp => this.isExpenseAvailableForSelection(exp));

    // Sort newest first (by date desc, then id desc) so restocked/new bill wins over old depleted bill
    const sorted = [...available].sort((a, b) => {
      const dateCmp = String(b.date || '').localeCompare(String(a.date || ''));
      if (dateCmp !== 0) return dateCmp;
      return String(b.id || '').localeCompare(String(a.id || ''));
    });

    const seen = new Set();
    const deduped = [];
    sorted.forEach(exp => {
      const key = exp.stockItemId ? `stk_${exp.stockItemId}` : `name_${this.normalizeProductName(exp.title)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const pricing = this.getExpenseUnitPricing(exp);
      const costPerPiece = pricing ? pricing.costPerPiece : (Number(exp.amount) || 0);
      deduped.push({
        id: exp.id,
        stockItemId: exp.stockItemId || null,
        normTitle: this.normalizeProductName(exp.title),
        title: exp.title || 'ไม่ระบุ',
        costPerPiece,
        pricingLabel: pricing ? pricing.badgeSpec : `฿${costPerPiece.toFixed(2)}`
      });
    });

    return deduped;
  }

  // Resolve a saved expenseId to the latest matching packaging option (handles old depleted bill IDs after restock)
  resolveLatestDsPackagingOption(pkgOptions, expId) {
    if (!expId) return null;
    const direct = pkgOptions.find(o => String(o.id) === String(expId));
    if (direct) return direct;
    const oldExp = (this.data.expenses || []).find(e => e && String(e.id) === String(expId));
    if (!oldExp) return null;
    if (oldExp.stockItemId) {
      const byStock = pkgOptions.find(o => o.stockItemId && String(o.stockItemId) === String(oldExp.stockItemId));
      if (byStock) return byStock;
    }
    const oldNorm = this.normalizeProductName(oldExp.title);
    return pkgOptions.find(o => o.normTitle === oldNorm) || null;
  }

  // ═══ ตรวจสอบว่ารายจ่ายนี้มีสต๊อกพร้อมใช้งานหรือไม่ (ซ่อนเฉพาะกรณีที่สต๊อกหมด qty <= 0) ═══
  isExpenseAvailableForSelection(exp) {
    if (!exp) return false;
    const stockItems = this.data.stockItems || [];
    const expTitleNorm = this.normalizeProductName(exp.title);
    // หา stock item ที่ตรงกับ expense (ตรวจชื่อด้วยป้องกัน stockItemId เก่าที่เคยรวมผิด)
    let stockItem = null;
    if (exp.stockItemId) {
      const byId = stockItems.find(s => s && String(s.id) === String(exp.stockItemId));
      if (byId && (!expTitleNorm || this.normalizeProductName(byId.name) === expTitleNorm)) {
        stockItem = byId;
      }
    }
    if (!stockItem && exp.title) {
      stockItem = stockItems.find(s => {
        if (!s || !s.name) return false;
        return this.normalizeProductName(s.name) === expTitleNorm;
      });
    }
    if (!stockItem) return true; // ไม่พบสต๊อก → แสดงให้เลือกได้ (ยังไม่ได้ซิงค์สต๊อก)
    const qty = Number(stockItem.qty) || 0;
    // ซ่อนเฉพาะถ้าหมดสต๊อก (qty <= 0)
    return qty > 0;
  }

  // ═══ Render cup size config cards (packaging, ml per cup) ═══
  renderDsCupSizeCards() {
    const container = document.getElementById('dsCupSizeCards');
    if (!container) return;
    const pkgOptions = this.getDsPackagingOptions();

    const makeSelect = (cupId, field, selectedId, label) => {
      const resolved = this.resolveLatestDsPackagingOption(pkgOptions, selectedId);
      const effectiveId = resolved ? resolved.id : selectedId;
      let opts = `<option value="">-- เลือก${label} --</option>`;
      pkgOptions.forEach(o => {
        const sel = String(o.id) === String(effectiveId) ? ' selected' : '';
        opts += `<option value="${o.id}"${sel}>${this.escapeHtml(o.title)} (${o.pricingLabel})</option>`;
      });
      return `<select class="form-input ds-pkg-select" data-cup-id="${cupId}" data-field="${field}" style="height:36px; font-size:0.8rem;">${opts}</select>`;
    };

    const cardsHtml = this.dsCupSizes.map(s => {
      const cupId = String(s.id || s.oz);
      const cfg = this.dsPackagingConfig[cupId] || { bundled: false, bundledExpId: '', cupExpId: '', lidExpId: '', strawExpId: '', mlPerCup: s.mlDefault };
      const bundledChecked = cfg.bundled ? ' checked' : '';
      const canDelete = this.dsCupSizes.length > 1;
      return `
        <div class="ds-cup-config-card" data-cup-id="${cupId}">
          <div class="ds-cup-config-header" style="flex-wrap:wrap; gap:0.5rem;">
            <div style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
              <span class="ds-cup-config-size">${s.oz} oz</span>
              <input type="text" class="form-input ds-cfg-label-input" data-cup-id="${cupId}" value="${this.escapeHtml(s.label || '')}" placeholder="รุ่น/หมายเหตุ (ถ้ามี)" style="height:30px; width:125px; font-size:0.78rem; padding:0.15rem 0.45rem;">
              ${canDelete ? `<button type="button" class="icon-btn text-danger" onclick="app.removeDsCupSize('${cupId}')" title="ลบรายการนี้" style="width:24px;height:24px;color:#ef4444;padding:0;"><i data-lucide="trash-2" style="width:13px;height:13px;"></i></button>` : ''}
            </div>
            <div style="display:flex; align-items:center; gap:0.55rem; flex-wrap:wrap;">
              <div class="ds-cup-config-ml">
                <label style="font-size:0.74rem; color:#64748b;">ราคาขาย</label>
                <div class="input-with-affix" style="width:76px;">
                  <span class="affix-left" style="font-size:0.72rem;">฿</span>
                  <input type="number" class="form-input ds-cfg-price-input" data-cup-id="${cupId}" value="${s.priceDefault ?? 0}" min="0" step="1" style="height:32px; text-align:center; font-size:0.82rem; font-weight:700;">
                </div>
              </div>
              <div class="ds-cup-config-ml">
                <label style="font-size:0.74rem; color:#64748b;">น้ำ/แก้ว</label>
                <div class="input-with-affix" style="width:86px;">
                  <input type="number" class="form-input ds-ml-input" data-cup-id="${cupId}" value="${cfg.mlPerCup}" min="0" step="10" style="height:32px; text-align:center; font-size:0.82rem; font-weight:600;">
                  <span class="affix-right" style="font-size:0.7rem;">ml</span>
                </div>
              </div>
            </div>
          </div>
          <div class="ds-cup-pkg-section">
            <label class="ds-bundled-toggle">
              <input type="checkbox" class="ds-bundled-cb" data-cup-id="${cupId}"${bundledChecked}>
              <span>รวมแก้ว+ฝา+หลอดแล้ว (ชุดเดียว)</span>
            </label>
            <div class="ds-pkg-fields" id="dsPkgFields${cupId}">
              ${cfg.bundled ? `
                <div class="form-group mb-1">
                  <label class="form-label" style="font-size:0.75rem;">📦 เลือกชุดบรรจุภัณฑ์</label>
                  ${makeSelect(cupId, 'bundledExpId', cfg.bundledExpId, 'ชุดบรรจุภัณฑ์')}
                </div>
              ` : `
                <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:0.4rem;">
                  <div class="form-group mb-1">
                    <label class="form-label" style="font-size:0.72rem;">🥤 แก้ว</label>
                    ${makeSelect(cupId, 'cupExpId', cfg.cupExpId, 'แก้ว')}
                  </div>
                  <div class="form-group mb-1">
                    <label class="form-label" style="font-size:0.72rem;">🔵 ฝา</label>
                    ${makeSelect(cupId, 'lidExpId', cfg.lidExpId, 'ฝา')}
                  </div>
                  <div class="form-group mb-1">
                    <label class="form-label" style="font-size:0.72rem;">🥢 หลอด</label>
                    ${makeSelect(cupId, 'strawExpId', cfg.strawExpId, 'หลอด')}
                  </div>
                </div>
              `}
            </div>
          </div>
          <div class="ds-cup-pkg-cost" id="dsPkgCost${cupId}" style="font-size:0.78rem; color:#64748b; padding:0.3rem 0.5rem; margin-top:0.3rem;"></div>
        </div>
      `;
    }).join('');

    const addBarHtml = `
    <div style="padding:0.75rem 1rem; background:#f8fafc; border-top:1px dashed #cbd5e1; display:flex; align-items:flex-end; gap:0.45rem; flex-wrap:wrap;">
      <div style="width:68px;">
        <label style="font-size:0.7rem; color:#64748b; font-weight:600; display:block; margin-bottom:2px;">ขนาด (oz)</label>
        <input type="number" id="dsNewCupOz" class="form-input" placeholder="16" min="1" step="1" style="height:34px; font-size:0.82rem; text-align:center;">
      </div>
      <div style="flex:1.2; min-width:110px;">
        <label style="font-size:0.7rem; color:#64748b; font-weight:600; display:block; margin-bottom:2px;">ชื่อ/รุ่นแก้ว (ถ้าซ้ำ)</label>
        <input type="text" id="dsNewCupLabel" class="form-input" placeholder="เช่น แก้วแข็ง, แก้วปั่น" style="height:34px; font-size:0.82rem;">
      </div>
      <div style="width:72px;">
        <label style="font-size:0.7rem; color:#64748b; font-weight:600; display:block; margin-bottom:2px;">ราคา (฿)</label>
        <input type="number" id="dsNewCupPrice" class="form-input" placeholder="15" min="0" step="1" style="height:34px; font-size:0.82rem; text-align:center;">
      </div>
      <div style="width:76px;">
        <label style="font-size:0.7rem; color:#64748b; font-weight:600; display:block; margin-bottom:2px;">น้ำ (ml)</label>
        <input type="number" id="dsNewCupMl" class="form-input" placeholder="250" min="0" step="10" style="height:34px; font-size:0.82rem; text-align:center;">
      </div>
      <button type="button" class="btn-outline-fastwork btn-sm" onclick="app.addDsCupSize()" style="height:34px; padding:0 0.75rem; font-weight:700; white-space:nowrap;">
        + เพิ่มแก้ว
      </button>
    </div>
  `;

    container.innerHTML = cardsHtml + addBarHtml;

    // Bind events
    container.querySelectorAll('.ds-cfg-label-input').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const cid = e.target.dataset.cupId;
        const cupObj = this.dsCupSizes.find(c => String(c.id || c.oz) === String(cid));
        if (cupObj) cupObj.label = e.target.value;
        const rowLabel = document.getElementById(`dsCupRowLabel${cid}`);
        if (rowLabel) {
          const lbl = (e.target.value || '').trim();
          rowLabel.textContent = lbl ? `(${lbl})` : '';
        }
        this.saveData();
      });
    });
    container.querySelectorAll('.ds-cfg-price-input').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const cid = e.target.dataset.cupId;
        const val = parseFloat(e.target.value) || 0;
        const cupObj = this.dsCupSizes.find(c => String(c.id || c.oz) === String(cid));
        if (cupObj) cupObj.priceDefault = val;
        const step2Price = document.getElementById(`dsCupPrice${cid}`);
        if (step2Price) step2Price.value = val;
        this.saveData();
        this.calculateDrinkSalesCups();
      });
    });
    container.querySelectorAll('.ds-ml-input').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const cid = e.target.dataset.cupId;
        this.dsPackagingConfig[cid].mlPerCup = parseFloat(e.target.value) || 0;
        this.saveData();
        this.updateDsPkgCostDisplay(cid);
      });
    });
    container.querySelectorAll('.ds-bundled-cb').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const cid = e.target.dataset.cupId;
        this.dsPackagingConfig[cid].bundled = e.target.checked;
        this.saveData();
        this.renderDsCupSizeCards();
      });
    });
    container.querySelectorAll('.ds-pkg-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const cid = e.target.dataset.cupId;
        const field = e.target.dataset.field;
        this.dsPackagingConfig[cid][field] = e.target.value;
        this.saveData();
        this.updateDsPkgCostDisplay(cid);
      });
    });

    // Show cost per cup for each size
    this.dsCupSizes.forEach(s => this.updateDsPkgCostDisplay(String(s.id || s.oz)));
    this.refreshLucide();
  }

  addDsCupSize() {
    const oz = parseFloat(document.getElementById('dsNewCupOz')?.value);
    const label = (document.getElementById('dsNewCupLabel')?.value || '').trim();
    const price = parseFloat(document.getElementById('dsNewCupPrice')?.value);
    const ml = parseFloat(document.getElementById('dsNewCupMl')?.value);
    if (!oz || oz <= 0) {
      this.showToast('กรุณาระบุขนาดแก้ว (oz)', 'warning');
      return;
    }
    const newId = 'cup_' + Date.now() + Math.random().toString(36).substring(2, 5);
    const sameOzCount = this.dsCupSizes.filter(s => Number(s.oz) === oz).length;
    const effectiveLabel = label || (sameOzCount > 0 ? `แบบที่ ${sameOzCount + 1}` : '');
    const newSize = {
      id: newId,
      oz,
      label: effectiveLabel,
      mlDefault: (!isNaN(ml) && ml >= 0) ? ml : Math.round(oz * 15),
      priceDefault: (!isNaN(price) && price >= 0) ? price : 10
    };
    this.dsCupSizes.push(newSize);
    this.dsCupSizes.sort((a, b) => Number(a.oz) - Number(b.oz));
    this.dsPackagingConfig[newId] = { bundled: false, bundledExpId: '', cupExpId: '', lidExpId: '', strawExpId: '', mlPerCup: newSize.mlDefault };
    this.saveData();
    this.renderDsCupSizeCards();
    this.renderDsCupCountRows();
    this.showToast(`เพิ่มแก้ว ${oz} oz${effectiveLabel ? ` (${effectiveLabel})` : ''} เรียบร้อยแล้ว`, 'success');
  }

  removeDsCupSize(cupId) {
    if (this.dsCupSizes.length <= 1) return;
    const target = this.dsCupSizes.find(s => String(s.id || s.oz) === String(cupId));
    const desc = target ? `${target.oz} oz${target.label ? ` (${target.label})` : ''}` : cupId;
    if (!confirm(`ต้องการลบแก้ว ${desc} ออกจากรายการหรือไม่?`)) return;
    this.data.dsCupSizes = this.dsCupSizes.filter(s => String(s.id || s.oz) !== String(cupId));
    this.dsCupSizes = this.data.dsCupSizes;
    this.saveData();
    this.renderDsCupSizeCards();
    this.renderDsCupCountRows();
    this.calculateDrinkSalesCups();
  }

  renderDsCupCountRows() {
    const tbody = document.getElementById('dsCupCountTbody');
    if (!tbody) return;

    // Preserve current before/after values while re-rendering
    const prevValues = {};
    (this.dsCupSizes || []).forEach(s => {
      const cid = String(s.id || s.oz);
      const bEl = document.getElementById(`dsCupBefore${cid}`);
      const aEl = document.getElementById(`dsCupAfter${cid}`);
      if (bEl || aEl) {
        prevValues[cid] = { before: bEl?.value || '', after: aEl?.value || '' };
      }
    });

    tbody.innerHTML = (this.dsCupSizes || []).map(s => {
      const cid = String(s.id || s.oz);
      const prev = prevValues[cid] || { before: '', after: '' };
      return `
      <div class="ds-cup-count-card">
        <div class="ds-cup-count-top">
          <div class="ds-cup-count-title">
            <span class="ds-size-pill">${s.oz} oz</span>
            <span id="dsCupRowLabel${cid}" class="ds-cup-count-sub">${s.label ? `(${this.escapeHtml(s.label)})` : ''}</span>
          </div>
          <div class="ds-cup-count-live">
            <span class="ds-sold-pill" id="dsCupSold${cid}">0 แก้ว</span>
            <span class="ds-rev-pill" id="dsCupRev${cid}">฿0</span>
          </div>
        </div>
        <div class="ds-cup-count-inputs">
          <div class="ds-cup-input-group">
            <label for="dsCupPrice${cid}">ราคาขาย</label>
            <div class="input-with-affix">
              <span class="affix-left">฿</span>
              <input type="number" id="dsCupPrice${cid}" class="form-input drink-sales-cup-price" data-cup-id="${cid}" value="${s.priceDefault ?? 0}" min="0" step="1">
            </div>
          </div>
          <div class="ds-cup-input-group">
            <label for="dsCupBefore${cid}">ก่อนขาย</label>
            <input type="number" id="dsCupBefore${cid}" class="form-input drink-sales-cup-before" value="${this.escapeHtml(prev.before)}" placeholder="0" min="0" step="1">
          </div>
          <div class="ds-cup-input-group">
            <label for="dsCupAfter${cid}">หลังขาย</label>
            <input type="number" id="dsCupAfter${cid}" class="form-input drink-sales-cup-after" value="${this.escapeHtml(prev.after)}" placeholder="0" min="0" step="1">
          </div>
        </div>
      </div>
    `;
    }).join('');

    tbody.querySelectorAll('.drink-sales-cup-before, .drink-sales-cup-after').forEach(input => {
      input.addEventListener('input', () => this.calculateDrinkSalesCups());
    });
    tbody.querySelectorAll('.drink-sales-cup-price').forEach(input => {
      input.addEventListener('input', (e) => {
        const cid = e.target.dataset.cupId;
        const val = parseFloat(e.target.value) || 0;
        const cupObj = (this.dsCupSizes || []).find(c => String(c.id || c.oz) === String(cid));
        if (cupObj) cupObj.priceDefault = val;
        const cfgPrice = document.querySelector(`.ds-cfg-price-input[data-cup-id="${cid}"]`);
        if (cfgPrice) cfgPrice.value = val;
        this.saveData();
        this.calculateDrinkSalesCups();
      });
    });

    this.calculateDrinkSalesCups();
  }

  // ═══ Calculate & display packaging cost per cup for a size ═══
  getDsPackagingCostPerCup(sizeOz) {
    const cfg = this.dsPackagingConfig[sizeOz];
    if (!cfg) return 0;
    const pkgOptions = this.getDsPackagingOptions();
    const findCost = (expId) => {
      const opt = this.resolveLatestDsPackagingOption(pkgOptions, expId);
      return opt ? opt.costPerPiece : 0;
    };
    if (cfg.bundled) {
      return findCost(cfg.bundledExpId);
    } else {
      return findCost(cfg.cupExpId) + findCost(cfg.lidExpId) + findCost(cfg.strawExpId);
    }
  }

  updateDsPkgCostDisplay(sizeOz) {
    const el = document.getElementById(`dsPkgCost${sizeOz}`);
    if (!el) return;
    const cost = this.getDsPackagingCostPerCup(sizeOz);
    const cfg = this.dsPackagingConfig[sizeOz];
    if (cost > 0) {
      el.innerHTML = `📦 ต้นทุนบรรจุภัณฑ์/แก้ว: <strong style="color:#dc2626;">฿${cost.toFixed(2)}</strong> | น้ำ/แก้ว: <strong>${cfg.mlPerCup} ml</strong>`;
    } else {
      el.innerHTML = `<span style="color:#94a3b8;">ยังไม่ได้เลือกบรรจุภัณฑ์</span> | น้ำ/แก้ว: <strong>${cfg.mlPerCup} ml</strong>`;
    }
  }

  // ═══ Render inline clickable recipe cards ═══
  renderDsInlineRecipes() {
    const container = document.getElementById('dsRecipeInlineList');
    if (!container) return;

    const recipes = (this.data.recipes || []).filter(r => {
      const mode = r.mode || (r.yieldCups === 1 && (!r.jarLiters || r.jarLiters <= 0.5) ? 'cup' : 'jar');
      return mode !== 'cup';
    });

    if (recipes.length === 0) {
      container.innerHTML = '<div style="text-align:center; color:#94a3b8; padding:1rem; font-size:0.85rem;">ไม่พบสูตรน้ำประเภทโหล/ถัง กรุณาเพิ่มสูตรน้ำในหน้า "สูตรชงน้ำ" ก่อน</div>';
      return;
    }

    container.innerHTML = recipes.map(recipe => {
      const jarCost = this.calculateRecipeJarCost(recipe);
      const unitCost = this.calculateRecipeUnitCost(recipe);
      const jarL = parseFloat(recipe.jarLiters) || 5;
      const yieldCups = parseInt(recipe.yieldCups) || 24;
      const isSelected = this.drinkSalesSelectedRecipeIds && this.drinkSalesSelectedRecipeIds.has(String(recipe.id));
      const selectedClass = isSelected ? ' ds-recipe-card-selected' : '';
      return `
        <div class="ds-recipe-card${selectedClass}" data-recipe-id="${recipe.id}" onclick="app.toggleDsRecipe('${recipe.id}')">
          <div class="ds-recipe-card-check">${isSelected ? '✅' : '⬜'}</div>
          <div class="ds-recipe-card-info">
            <div class="ds-recipe-card-name">${this.escapeHtml(recipe.name || 'ไม่ระบุ')}</div>
            <div class="ds-recipe-card-detail">
              ทุน ฿${jarCost.toFixed(1)}/โหล (${jarL}L) → ฿${unitCost.toFixed(2)}/แก้ว (${yieldCups} แก้ว)
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  toggleDsRecipe(recipeId) {
    if (!this.drinkSalesSelectedRecipeIds) this.drinkSalesSelectedRecipeIds = new Set();
    const rid = String(recipeId);
    if (this.drinkSalesSelectedRecipeIds.has(rid)) {
      this.drinkSalesSelectedRecipeIds.delete(rid);
    } else {
      this.drinkSalesSelectedRecipeIds.add(rid);
    }
    this.renderDsInlineRecipes();
  }

  // ═══ Calculate cups sold (dynamic from configured cup sizes/variants) ═══
  calculateDrinkSalesCups() {
    let totalSold = 0;
    let totalRevenue = 0;
    const cupData = {};

    (this.dsCupSizes || []).forEach(s => {
      const cid = String(s.id || s.oz);
      const before = parseInt(document.getElementById(`dsCupBefore${cid}`)?.value) || 0;
      const after = parseInt(document.getElementById(`dsCupAfter${cid}`)?.value) || 0;
      const sold = Math.max(0, before - after);
      const price = parseFloat(document.getElementById(`dsCupPrice${cid}`)?.value) || 0;
      const soldEl = document.getElementById(`dsCupSold${cid}`);
      if (soldEl) soldEl.textContent = `${sold} แก้ว`;

      const rev = sold * price;
      const revEl = document.getElementById(`dsCupRev${cid}`);
      if (revEl) revEl.textContent = `฿${rev.toFixed(0)}`;

      totalSold += sold;
      totalRevenue += rev;
      cupData[cid] = { id: cid, oz: s.oz, label: s.label || '', size: `${s.oz} oz`, price, before, after, sold, revenue: rev };
    });

    const totalSoldEl = document.getElementById('dsTotalCupsSold');
    const totalRevEl = document.getElementById('dsTotalRevenue');
    if (totalSoldEl) totalSoldEl.textContent = `${totalSold} แก้ว`;
    if (totalRevEl) totalRevEl.textContent = `฿${totalRevenue.toFixed(0)}`;

    this.drinkSalesData = { totalSold, totalRevenue, cupData };
  }

  // ═══ MAIN: Calculate drink sales profit ═══
  calculateDrinkSalesProfit() {
    // Recalculate cups first
    this.calculateDrinkSalesCups();

    if (!this.drinkSalesData || this.drinkSalesData.totalSold === 0) {
      this.showToast('กรุณากรอกจำนวนแก้วก่อน-หลังขายก่อน', 'error');
      return;
    }
    if (!this.drinkSalesSelectedRecipeIds || this.drinkSalesSelectedRecipeIds.size === 0) {
      this.showToast('กรุณาเลือกสูตรน้ำอย่างน้อย 1 สูตร', 'error');
      return;
    }

    const cupData = this.drinkSalesData.cupData || {};
    const totalSold = this.drinkSalesData.totalSold;
    const totalRevenue = this.drinkSalesData.totalRevenue;

    // ─── Get selected recipes ───
    const selectedRecipes = (this.data.recipes || []).filter(r => this.drinkSalesSelectedRecipeIds.has(String(r.id)));

    // ─── Average water cost per ml across selected recipes ───
    // Each recipe: cost per jar / jar liters in ml = cost per ml
    let totalCostPerMl = 0;
    const recipeDetails = selectedRecipes.map(recipe => {
      const jarCost = this.calculateRecipeJarCost(recipe);
      const jarLiters = parseFloat(recipe.jarLiters) || 5;
      const jarMl = jarLiters * 1000;
      const costPerMl = jarMl > 0 ? (jarCost / jarMl) : 0;
      const yieldCups = parseInt(recipe.yieldCups) || 24;
      totalCostPerMl += costPerMl;
      return { id: recipe.id, name: recipe.name, jarCost, jarLiters, jarMl, costPerMl, yieldCups };
    });
    const avgCostPerMl = recipeDetails.length > 0 ? (totalCostPerMl / recipeDetails.length) : 0;

    // ─── Total water needed by cups sold ───
    let totalWaterNeededMl = 0;
    const perSizeBreakdown = (this.dsCupSizes || []).map(s => {
      const cid = String(s.id || s.oz);
      const sizeOz = Number(s.oz);
      const label = s.label || '';
      const cfg = this.dsPackagingConfig[cid] || {};
      const mlPerCup = cfg.mlPerCup || 0;
      const sold = cupData[cid]?.sold || 0;
      const price = cupData[cid]?.price || 0;
      const revenue = sold * price;

      // Water cost per cup
      const waterCostPerCup = avgCostPerMl * mlPerCup;

      // Packaging cost per cup
      const pkgCostPerCup = this.getDsPackagingCostPerCup(cid);

      // Total cost per cup
      const totalCostPerCup = waterCostPerCup + pkgCostPerCup;

      // Totals for this size
      const totalWaterCost = waterCostPerCup * sold;
      const totalPkgCost = pkgCostPerCup * sold;
      const totalCostSize = totalCostPerCup * sold;
      const profitSize = revenue - totalCostSize;

      totalWaterNeededMl += mlPerCup * sold;

      return { cupId: cid, sizeOz, label, mlPerCup, sold, price, revenue, waterCostPerCup, pkgCostPerCup, totalCostPerCup, totalWaterCost, totalPkgCost, totalCostSize, profitSize };
    });

    // ─── Batch tracking per recipe (using actual jar sizes) ───
    const totalWaterNeededLiters = totalWaterNeededMl / 1000;
    const waterPerRecipeLiters = recipeDetails.length > 0 ? (totalWaterNeededLiters / recipeDetails.length) : 0;
    const perRecipeBatch = recipeDetails.map(r => {
      const batches = waterPerRecipeLiters > 0 ? Math.ceil(waterPerRecipeLiters / r.jarLiters) : 0;
      const prepared = batches * r.jarLiters;
      return { name: r.name, jarLiters: r.jarLiters, batches, prepared };
    });
    const batchCount = perRecipeBatch.reduce((s, r) => s + r.batches, 0);
    const totalPreparedLiters = perRecipeBatch.reduce((s, r) => s + r.prepared, 0);
    const batchLeftover = Math.max(0, totalPreparedLiters - totalWaterNeededLiters);
    const actualUsedLiters = totalWaterNeededLiters;

    // ─── Grand totals ───
    const grandTotalCost = perSizeBreakdown.reduce((s, b) => s + b.totalCostSize, 0);
    const grandTotalWaterCost = perSizeBreakdown.reduce((s, b) => s + b.totalWaterCost, 0);
    const grandTotalPkgCost = perSizeBreakdown.reduce((s, b) => s + b.totalPkgCost, 0);
    const grandProfit = totalRevenue - grandTotalCost;
    const profitPerCup = totalSold > 0 ? grandProfit / totalSold : 0;
    const avgCostPerCup = totalSold > 0 ? grandTotalCost / totalSold : 0;

    // ─── Store for saving ───
    this.lastDrinkSalesCalc = {
      totalSold,
      totalRevenue,
      avgCostPerCup,
      avgCostPerMl,
      grandTotalCost,
      grandTotalWaterCost,
      grandTotalPkgCost,
      grandProfit,
      profitPerCup,
      totalCost: grandTotalCost,
      totalProfit: grandProfit,
      batchCount,
      batchLeftover,
      totalPreparedLiters,
      actualUsedLiters,
      totalWaterNeededMl,
      perRecipeBatch,
      cups: cupData,
      perSizeBreakdown,
      recipes: recipeDetails.map(r => ({
        id: r.id, name: r.name, jarCost: r.jarCost, jarLiters: r.jarLiters, costPerMl: r.costPerMl, yieldCups: r.yieldCups
      }))
    };

    // ─── Render results ───
    const resultSection = document.getElementById('drinkSalesResultSection');
    if (resultSection) resultSection.style.display = 'block';

    const profitColor = grandProfit >= 0 ? '#16a34a' : '#dc2626';

    // Per-size breakdown HTML
    const sizeBreakdownHtml = perSizeBreakdown.filter(b => b.sold > 0).map(b => `
      <div style="padding:0.5rem 0.75rem; background:#f8fafc; border-radius:8px; border:1px solid #e2e8f0; margin-bottom:0.4rem;">
        <div style="font-weight:600; font-size:0.85rem;">${b.sizeOz} oz${b.label ? ` (${this.escapeHtml(b.label)})` : ''} — ขาย ${b.sold} แก้ว × ฿${b.price}</div>
        <div style="font-size:0.78rem; color:#64748b; display:flex; gap:0.8rem; flex-wrap:wrap; margin-top:0.2rem;">
          <span>น้ำ/แก้ว: ฿${b.waterCostPerCup.toFixed(2)} (${b.mlPerCup}ml)</span>
          <span>📦 บรรจุภัณฑ์/แก้ว: ฿${b.pkgCostPerCup.toFixed(2)}</span>
          <span>ทุนรวม/แก้ว: <strong style="color:#dc2626;">฿${b.totalCostPerCup.toFixed(2)}</strong></span>
        </div>
        <div style="font-size:0.78rem; display:flex; gap:0.8rem; margin-top:0.15rem;">
          <span>รายรับ: <strong class="text-primary">฿${b.revenue.toFixed(0)}</strong></span>
          <span>ทุนรวม: <strong style="color:#dc2626;">฿${b.totalCostSize.toFixed(2)}</strong></span>
          <span>กำไร: <strong style="color:${b.profitSize >= 0 ? '#16a34a' : '#dc2626'};">฿${b.profitSize.toFixed(2)}</strong></span>
        </div>
      </div>
    `).join('');

    // Recipe breakdown HTML
    const recipeBreakdownHtml = recipeDetails.map(r => `
      <div style="padding:0.4rem 0.75rem; background:#fefce8; border-radius:8px; border:1px solid #fde68a; margin-bottom:0.3rem; font-size:0.8rem;">
        <strong>${this.escapeHtml(r.name)}</strong> — ทุนโหล ฿${r.jarCost.toFixed(1)} (${r.jarLiters}L) | ฿${r.costPerMl.toFixed(4)}/ml
      </div>
    `).join('');

    document.getElementById('dsResultContent').innerHTML = `
      <div class="pack-sell-result-grid">
        <div class="pack-sell-result-card cost-card">
          <div class="pack-sell-result-title">📊 สรุปยอดขาย & ต้นทุน</div>
          <div class="pack-sell-result-row">
            <span>จำนวนแก้วที่ขายได้</span>
            <strong>${totalSold} แก้ว</strong>
          </div>
          <div class="pack-sell-result-row">
            <span>รายรับรวม</span>
            <strong class="text-primary">฿${totalRevenue.toFixed(2)}</strong>
          </div>
          <div class="pack-sell-result-row">
            <span>💧 ต้นทุนน้ำรวม</span>
            <strong style="color:#dc2626;">฿${grandTotalWaterCost.toFixed(2)}</strong>
          </div>
          <div class="pack-sell-result-row">
            <span>📦 ต้นทุนบรรจุภัณฑ์รวม</span>
            <strong style="color:#dc2626;">฿${grandTotalPkgCost.toFixed(2)}</strong>
          </div>
          <div class="pack-sell-result-row highlight">
            <span>ต้นทุนรวมทั้งหมด</span>
            <strong style="color:#dc2626;">฿${grandTotalCost.toFixed(2)}</strong>
          </div>
          <div class="pack-sell-result-row">
            <span>ต้นทุนเฉลี่ย/แก้ว</span>
            <strong style="color:#dc2626;">฿${avgCostPerCup.toFixed(2)}</strong>
          </div>
        </div>

        <div class="pack-sell-result-card profit-card">
          <div class="pack-sell-result-title">💰 กำไร</div>
          <div class="pack-sell-result-row">
            <span>กำไรเฉลี่ยต่อแก้ว</span>
            <strong style="color:${profitColor};">฿${profitPerCup.toFixed(2)}</strong>
          </div>
          <div class="pack-sell-result-row highlight-total">
            <span>🎯 กำไรรวมทั้งหมด</span>
            <strong style="color:${profitColor}; font-size:1.1rem;">฿${grandProfit.toFixed(2)}</strong>
          </div>
        </div>
      </div>

      <div style="margin-top:0.75rem;">
        <div style="font-weight:700; font-size:0.9rem; margin-bottom:0.4rem;">📋 แยกตามขนาดแก้ว</div>
        ${sizeBreakdownHtml}
      </div>

      <div style="margin-top:0.75rem;">
        <div style="font-weight:700; font-size:0.9rem; margin-bottom:0.4rem;">🏺 สูตรน้ำที่เลือก (${recipeDetails.length} สูตร) — เฉลี่ย ฿${avgCostPerMl.toFixed(4)}/ml</div>
        ${recipeBreakdownHtml}
      </div>

      <div style="margin-top:0.75rem; padding:0.6rem 0.8rem; background:#f0fdf4; border-radius:8px; border:1px solid #bbf7d0; font-size:0.82rem; line-height:1.5;">
        🫙 <strong>การใช้น้ำ & โหลที่ชง (คำนวณอัตโนมัติ):</strong><br>
        • ใช้น้ำตามจำนวนแก้วที่ขายได้: <strong>${totalWaterNeededLiters.toFixed(2)} ลิตร</strong> (${totalWaterNeededMl.toLocaleString()} ml)<br>
        • โหลที่ต้องชง (แบ่งเท่าตามสูตร ${recipeDetails.length} สูตร, สูตรละ ~${waterPerRecipeLiters.toFixed(1)}L):<br>
        ${perRecipeBatch.map(r => `&nbsp;&nbsp;- ${this.escapeHtml(r.name)}: <strong>${r.batches} โหล</strong> (ถัง ${r.jarLiters}L × ${r.batches} = ${r.prepared}L)`).join('<br>')}<br>
        • ชงรวม: <strong>${batchCount} โหล</strong> (${totalPreparedLiters.toFixed(1)} ลิตร)<br>
        • ปริมาณน้ำเหลือคงค้างในโหล: <strong>${batchLeftover.toFixed(2)} ลิตร</strong> (${(batchLeftover * 1000).toFixed(0)} ml) สามารถขายต่อรอบถัดไปได้
      </div>
    `;
    this.refreshLucide();
  }

  // Helper: ลบยอดของ drinkSalesLog ออกจาก dailySales (ใช้ตอนแก้ไขหรือลบประวัติ)
  removeDrinkSaleFromDailySales(log) {
    if (!log || !Array.isArray(this.data.dailySales)) return;
    const idx = this.data.dailySales.findIndex(d => d && d.date === log.date);
    if (idx === -1) return;
    const ex = this.data.dailySales[idx];
    const rev = Number(log.totalRevenue) || 0;
    const cost = Number(log.totalCost) || 0;
    const profit = Number(log.totalProfit) || 0;
    ex.revenue = Math.max(0, parseFloat(((Number(ex.revenue) || 0) - rev).toFixed(2)));
    ex.cost = Math.max(0, parseFloat(((Number(ex.cost) || 0) - cost).toFixed(2)));
    if (ex.materialCost !== undefined) {
      ex.materialCost = Math.max(0, parseFloat(((Number(ex.materialCost) || 0) - cost).toFixed(2)));
    }
    ex.profit = parseFloat(((Number(ex.profit) || 0) - profit).toFixed(2));
    // Remove matching note entry if present
    if (ex.note) {
      const recNames = (log.recipes || []).map(r => r.name).join(', ') || 'น้ำชง';
      const pStr = profit >= 0 ? `+฿${profit.toFixed(2)}` : `-฿${Math.abs(profit).toFixed(2)}`;
      const exactDesc = `💰 ขายน้ำชง ${log.totalSold} แก้ว [${recNames}] (กำไร ${pStr})`;
      ex.note = ex.note
        .split(', ')
        .filter(part => part.trim() !== exactDesc)
        .join(', ')
        .trim();
    }
    if ((Number(ex.revenue) || 0) === 0 && (Number(ex.materialCost) || 0) === 0 && !ex.note && (!ex.cupCount || ex.cupCount === 0)) {
      this.data.dailySales.splice(idx, 1);
    }
  }

  editDrinkSalesLog(logId) {
    const log = (this.data.drinkSalesLogs || []).find(l => l && l.id === logId);
    if (!log) return;

    this.editingDrinkSalesLogId = log.id;

    // 1. Restore cup inputs from log.cups
    const cupsObj = log.cups || {};
    (this.dsCupSizes || []).forEach(s => {
      const cid = String(s.id || s.oz);
      const saved = cupsObj[cid] || cupsObj[`cup${s.oz}`] || null;
      const beforeEl = document.getElementById(`dsCupBefore${cid}`);
      const afterEl = document.getElementById(`dsCupAfter${cid}`);
      const priceEl = document.getElementById(`dsCupPrice${cid}`);
      if (saved) {
        if (priceEl && saved.price !== undefined) priceEl.value = saved.price;
        if (beforeEl) beforeEl.value = saved.before ?? (saved.sold || 0);
        if (afterEl) afterEl.value = saved.after ?? 0;
      } else {
        if (beforeEl) beforeEl.value = '';
        if (afterEl) afterEl.value = '';
      }
    });

    // 2. Restore selected recipes
    this.drinkSalesSelectedRecipeIds = new Set((log.recipes || []).map(r => String(r.id)));
    this.renderDsInlineRecipes();

    // 3. Restore date
    const saveDateEl = document.getElementById('drinkSalesSaveDate');
    if (saveDateEl && log.date) saveDateEl.value = String(log.date).substring(0, 10);

    // 4. Recalculate & show result
    this.calculateDrinkSalesCups();
    this.calculateDrinkSalesProfit();

    // 5. Update Save button UI to Edit mode
    const btnText = document.getElementById('btnSaveDrinkSalesLogText');
    const cancelBtn = document.getElementById('btnCancelEditDrinkSalesLog');
    if (btnText) btnText.textContent = 'อัปเดตประวัติยอดขาย';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';

    document.getElementById('tab-drink-sales')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.showToast(`📝 โหลดข้อมูลวันที่ ${this.formatThaiDate(log.date)} สำหรับแก้ไขแล้ว`, 'info');
  }

  cancelEditDrinkSalesLog() {
    this.editingDrinkSalesLogId = null;
    const btnText = document.getElementById('btnSaveDrinkSalesLogText');
    const cancelBtn = document.getElementById('btnCancelEditDrinkSalesLog');
    if (btnText) btnText.textContent = 'บันทึกประวัติยอดขาย';
    if (cancelBtn) cancelBtn.style.display = 'none';
    this.showToast('ยกเลิกการแก้ไขแล้ว', 'info');
  }

  saveDrinkSalesLog() {
    if (!this.lastDrinkSalesCalc || this.lastDrinkSalesCalc.totalSold <= 0) {
      this.showToast('กรุณากรอกจำนวนแก้วและคำนวณกำไรก่อนบันทึกประวัติ', 'warning');
      return;
    }

    if (!Array.isArray(this.data.drinkSalesLogs)) {
      this.data.drinkSalesLogs = [];
    }

    const calc = this.lastDrinkSalesCalc;
    const now = new Date();
    const selectedDate = document.getElementById('drinkSalesSaveDate')?.value || this.formatDate(now);
    const isEditing = Boolean(this.editingDrinkSalesLogId);
    let oldDate = null;

    if (isEditing) {
      const oldIdx = this.data.drinkSalesLogs.findIndex(l => l && l.id === this.editingDrinkSalesLogId);
      if (oldIdx !== -1) {
        const oldLog = this.data.drinkSalesLogs[oldIdx];
        oldDate = oldLog.date;
        this.removeDrinkSaleFromDailySales(oldLog);
        this.data.drinkSalesLogs[oldIdx] = {
          ...oldLog,
          date: selectedDate,
          cups: calc.cups,
          totalSold: calc.totalSold,
          totalRevenue: calc.totalRevenue,
          avgCostPerCup: calc.avgCostPerCup,
          totalCost: calc.totalCost,
          totalProfit: calc.totalProfit,
          profitPerCup: calc.profitPerCup,
          grandTotalWaterCost: calc.grandTotalWaterCost,
          grandTotalPkgCost: calc.grandTotalPkgCost,
          batchCount: calc.batchCount,
          batchLeftover: calc.batchLeftover,
          totalPreparedLiters: calc.totalPreparedLiters,
          actualUsedLiters: calc.actualUsedLiters,
          perRecipeBatch: calc.perRecipeBatch,
          perSizeBreakdown: calc.perSizeBreakdown,
          recipes: calc.recipes
        };
      } else {
        isEditing && (this.editingDrinkSalesLogId = null);
      }
    }

    if (!isEditing) {
      const newLog = {
        id: 'dsl_' + Date.now() + Math.random().toString(36).substring(2, 5),
        date: selectedDate,
        time: now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
        timestamp: Date.now(),
        cups: calc.cups,
        totalSold: calc.totalSold,
        totalRevenue: calc.totalRevenue,
        avgCostPerCup: calc.avgCostPerCup,
        totalCost: calc.totalCost,
        totalProfit: calc.totalProfit,
        profitPerCup: calc.profitPerCup,
        grandTotalWaterCost: calc.grandTotalWaterCost,
        grandTotalPkgCost: calc.grandTotalPkgCost,
        batchCount: calc.batchCount,
        batchLeftover: calc.batchLeftover,
        totalPreparedLiters: calc.totalPreparedLiters,
        actualUsedLiters: calc.actualUsedLiters,
        perRecipeBatch: calc.perRecipeBatch,
        perSizeBreakdown: calc.perSizeBreakdown,
        recipes: calc.recipes
      };
      this.data.drinkSalesLogs.unshift(newLog);
    }

    // ─── บันทึกเข้า Daily Sales (ยอดขายประจำวัน) อัตโนมัติ เหมือนกำไรจากเบิกขายสำเร็จรูป/ลัง ───
    const totalRevenue = calc.totalRevenue || 0;
    const totalCost = calc.totalCost || 0;
    const totalProfit = calc.totalProfit || 0;
    const saleDate = selectedDate;

    if (totalRevenue > 0 || totalCost > 0) {
      if (!Array.isArray(this.data.dailySales)) {
        this.data.dailySales = [];
      }

      const recipeNames = (calc.recipes || []).map(r => r.name).join(', ') || 'น้ำชง';
      const profitStr = totalProfit >= 0 ? `+฿${totalProfit.toFixed(2)}` : `-฿${Math.abs(totalProfit).toFixed(2)}`;
      const saleDesc = `💰 ขายน้ำชง ${calc.totalSold} แก้ว [${recipeNames}] (กำไร ${profitStr})`;

      const existingIndex = this.data.dailySales.findIndex(d => d.date === saleDate);
      if (existingIndex !== -1) {
        const ex = this.data.dailySales[existingIndex];
        ex.revenue = parseFloat(((Number(ex.revenue) || 0) + totalRevenue).toFixed(2));
        ex.cost = parseFloat(((Number(ex.cost) || 0) + totalCost).toFixed(2));
        ex.materialCost = parseFloat(((Number(ex.materialCost) || 0) + totalCost).toFixed(2));
        ex.profit = parseFloat(((Number(ex.profit) || 0) + totalProfit).toFixed(2));
        ex.note = ex.note ? `${ex.note}, ${saleDesc}` : saleDesc;
      } else {
        const costInfo = this.getSystemCostForDate(saleDate, totalRevenue);
        const dailyRent = costInfo.dailyRent || 0;
        const newRecord = {
          id: 'd_' + Date.now(),
          date: saleDate,
          revenue: totalRevenue,
          cost: parseFloat((totalCost + dailyRent).toFixed(2)),
          materialCost: totalCost,
          dailyRent: dailyRent,
          profit: parseFloat((totalRevenue - totalCost - dailyRent).toFixed(2)),
          note: saleDesc
        };
        this.data.dailySales.unshift(newRecord);
      }
    }

    this.editingDrinkSalesLogId = null;
    const btnText = document.getElementById('btnSaveDrinkSalesLogText');
    const cancelBtn = document.getElementById('btnCancelEditDrinkSalesLog');
    if (btnText) btnText.textContent = 'บันทึกประวัติยอดขาย';
    if (cancelBtn) cancelBtn.style.display = 'none';

    this.saveData();
    this.renderDrinkSalesHistory();
    this.renderDailyHistoryTable();
    this.renderDashboard();
    this.renderTodaySummary(saleDate);
    if (oldDate && oldDate !== saleDate) this.renderTodaySummary(oldDate);
    this.renderCalendar();
    this.showToast(
      isEditing
        ? `✅ อัปเดตประวัติยอดขายน้ำชง (${this.formatThaiDate(saleDate)}) เรียบร้อยแล้ว!`
        : `✅ บันทึกประวัติยอดขายน้ำชง (${this.formatThaiDate(saleDate)}) เรียบร้อยแล้ว!`,
      'success'
    );
  }

  renderDrinkSalesHistory() {
    const listContainer = document.getElementById('drinkSalesHistoryList');
    const badge = document.getElementById('drinkSalesHistoryCount');
    if (!listContainer) return;

    if (!Array.isArray(this.data.drinkSalesLogs)) {
      this.data.drinkSalesLogs = [];
    }
    const logs = this.data.drinkSalesLogs;
    if (badge) badge.textContent = `${logs.length} รายการ`;

    const sumSold = logs.reduce((s, l) => s + (Number(l.totalSold) || 0), 0);
    const sumRev = logs.reduce((s, l) => s + (Number(l.totalRevenue) || 0), 0);
    const sumProfit = logs.reduce((s, l) => s + (Number(l.totalProfit) || 0), 0);
    const isProfit = sumProfit >= 0;

    const heroSoldEl = document.getElementById('dsHeroTotalHistorySold');
    if (heroSoldEl) heroSoldEl.textContent = `${sumSold.toLocaleString()} แก้ว`;

    const heroRevEl = document.getElementById('dsHeroTotalHistoryRevenue');
    if (heroRevEl) heroRevEl.textContent = `฿${sumRev.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

    const heroProfitEl = document.getElementById('dsHeroTotalHistoryProfit');
    if (heroProfitEl) {
      heroProfitEl.textContent = `${isProfit ? '+' : ''}฿${sumProfit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      heroProfitEl.style.color = isProfit ? '#6ee7b7' : '#fca5a5';
    }

    if (logs.length === 0) {
      listContainer.innerHTML = `
        <div class="figma-tx-empty" style="padding:1.5rem 1rem;">
          <div class="figma-tx-empty-icon"><i data-lucide="inbox"></i></div>
          <div class="figma-tx-empty-title">ยังไม่มีประวัติการบันทึกยอดขายน้ำชง</div>
          <div class="figma-tx-empty-desc">เมื่อคำนวณกำไรเสร็จแล้ว กดปุ่ม "บันทึกประวัติยอดขายน้ำ" เพื่อบันทึกประวัติไว้ที่นี่</div>
        </div>
      `;
      this.refreshLucide();
      return;
    }

    listContainer.innerHTML = logs.map(log => {
      const recList = log.recipes || [];
      const profitClass = log.totalProfit >= 0 ? 'color:#15803d;' : 'color:#dc2626;';
      const profitSign = log.totalProfit >= 0 ? '+' : '';

      // Per-size detail chips (clean spacing, no cramped parentheses)
      let perSizeHtml = '';
      if (log.perSizeBreakdown) {
        perSizeHtml = log.perSizeBreakdown.filter(b => b.sold > 0).map(b => `
        <div class="dsh-size-chip">
          <span class="dsh-size-tag">${b.sizeOz}oz${b.label ? ` (${this.escapeHtml(b.label)})` : ''}</span>
          <span class="dsh-size-qty"><b>${b.sold}</b> แก้ว</span>
          <span class="dsh-size-meta">ขาย ฿${b.price} · ทุน ฿${b.totalCostPerCup.toFixed(1)}</span>
        </div>
      `).join('');
      } else {
        perSizeHtml = [
          { sz: '10oz', qty: log.cups?.cup10?.sold ?? 0 },
          { sz: '16oz', qty: log.cups?.cup16?.sold ?? 0 },
          { sz: '28oz', qty: log.cups?.cup28?.sold ?? 0 }
        ].filter(x => x.qty > 0).map(x => `
        <div class="dsh-size-chip">
          <span class="dsh-size-tag">${x.sz}</span>
          <span class="dsh-size-qty"><b>${x.qty}</b> แก้ว</span>
        </div>
      `).join('');
      }

      // Merge recipe names + batch count into clean pills (avoid repeating recipe list twice)
      let recipePillsHtml = '';
      if (log.perRecipeBatch && log.perRecipeBatch.length > 0) {
        recipePillsHtml = log.perRecipeBatch.map(r =>
          `<span class="dsh-recipe-pill">${this.escapeHtml(r.name)} <b>${r.batches}×${r.jarLiters}L</b></span>`
        ).join('');
      } else if (recList.length > 0) {
        recipePillsHtml = recList.map(r =>
          `<span class="dsh-recipe-pill">${this.escapeHtml(r.name)}</span>`
        ).join('');
      } else {
        recipePillsHtml = `<span class="dsh-recipe-pill">ไม่ระบุสูตร</span>`;
      }

      const hasWaterStats = (log.perRecipeBatch && log.perRecipeBatch.length > 0) || log.batchCount;
      const waterSummaryHtml = hasWaterStats ? `
      <div class="dsh-water-bar">
        <span>🫙 ชงรวม <b>${Number(log.totalPreparedLiters || 0).toFixed(1)}L</b></span>
        <span class="dsh-dot">•</span>
        <span>ใช้จริง <b>${Number(log.actualUsedLiters || 0).toFixed(1)}L</b></span>
        <span class="dsh-dot">•</span>
        <span style="color:#0284c7;">เหลือ <b>${Number(log.batchLeftover || 0).toFixed(1)}L</b></span>
      </div>
    ` : '';

      return `
        <div class="drink-sales-history-card dsh-card-clean">
          <div class="dsh-header">
            <div class="dsh-date">
              <i data-lucide="calendar" style="width:14px;height:14px;"></i>
              <span>${this.formatThaiDate(log.date)} · ${log.time || ''} น.</span>
            </div>
            <div style="display:flex; align-items:center; gap:0.35rem;">
              <span class="dsh-total-pill">รวม <b>${log.totalSold}</b> แก้ว</span>
              <button type="button" class="icon-btn" title="แก้ไขรายการนี้" onclick="app.editDrinkSalesLog('${log.id}')" style="width:28px;height:28px;color:#2563eb;">
                <i data-lucide="edit-3" style="width:14px;height:14px;"></i>
              </button>
              <button type="button" class="icon-btn text-danger" title="ลบรายการนี้" onclick="app.deleteDrinkSalesLog('${log.id}')" style="width:28px;height:28px;color:#ef4444;">
                <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
              </button>
            </div>
          </div>

          <div class="dsh-sizes-wrap">
            ${perSizeHtml}
          </div>

          <div class="dsh-recipes-box">
            <div class="dsh-recipes-pills">
              ${recipePillsHtml}
            </div>
            ${waterSummaryHtml}
          </div>

          <div class="dsh-finance-grid">
            <div class="dsh-fin-item">
              <span class="dsh-fin-lbl">รายรับรวม</span>
              <span class="dsh-fin-val text-primary">฿${Number(log.totalRevenue || 0).toLocaleString()}</span>
            </div>
            <div class="dsh-fin-item">
              <span class="dsh-fin-lbl">ต้นทุนรวม</span>
              <span class="dsh-fin-val" style="color:#dc2626;">฿${Number(log.totalCost || 0).toFixed(2)}</span>
            </div>
            <div class="dsh-fin-item highlight">
              <span class="dsh-fin-lbl">กำไรสุทธิ</span>
              <span class="dsh-fin-val" style="${profitClass}">
                ${profitSign}฿${Number(log.totalProfit || 0).toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    this.refreshLucide();
  }

  deleteDrinkSalesLog(logId) {
    if (!confirm('คุณแน่ใจหรือไม่ว่าต้องการลบรายการประวัตินี้?')) return;
    if (!Array.isArray(this.data.drinkSalesLogs)) return;
    const target = this.data.drinkSalesLogs.find(l => l && l.id === logId);
    if (target) {
      this.removeDrinkSaleFromDailySales(target);
    }
    if (this.editingDrinkSalesLogId === logId) {
      this.cancelEditDrinkSalesLog();
    }
    this.data.drinkSalesLogs = this.data.drinkSalesLogs.filter(l => l.id !== logId);
    this.saveData();
    this.renderDrinkSalesHistory();
    this.renderDailyHistoryTable();
    this.renderDashboard();
    if (target?.date) this.renderTodaySummary(target.date);
    this.renderCalendar();
    this.showToast('ลบรายการประวัติยอดขายน้ำเรียบร้อย', 'info');
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