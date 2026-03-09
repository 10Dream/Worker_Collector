import os
import yaml
import requests
import logging
import time
from bs4 import BeautifulSoup
from datetime import datetime, timedelta, timezone

# تنظیمات لاگر حرفه‌ای
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [%(levelname)s] - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

def load_settings():
    try:
        if not os.path.exists('config/settings.yaml'):
            logger.warning("فایل تنظیمات یافت نشد، از مقادیر پیش‌فرض استفاده می‌شود.")
            return {
                'scraping': {'lookback_days': 2, 'max_pages': 30}, 
                'storage': {'base_path': 'src/telegram'}
            }
        with open('config/settings.yaml', 'r', encoding='utf-8') as f:
            return yaml.safe_load(f)
    except Exception as e:
        logger.error(f"خطا در بارگذاری تنظیمات: {e}")
        return {
            'scraping': {'lookback_days': 2, 'max_pages': 30}, 
            'storage': {'base_path': 'src/telegram'}
        }

def load_channels():
    if not os.path.exists('config/channels.txt'):
        logger.error("فایل config/channels.txt یافت نشد!")
        return []
    try:
        usernames = []
        with open('config/channels.txt', 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    username = line.split('/')[-1].replace('@', '').split('?')[0]
                    usernames.append(username)
        return usernames
    except Exception as e:
        logger.error(f"خطا در خواندن فایل کانال‌ها: {e}")
        return []

def html_to_md(element):
    if not element: return ""
    try:
        for b in element.find_all('b'): b.replace_with(f"**{b.get_text()}**")
        for i in element.find_all('i'): i.replace_with(f"*{i.get_text()}*")
        for code in element.find_all('code'): code.replace_with(f"`{code.get_text()}`")
        for a in element.find_all('a'):
            href = a.get('href', '')
            a.replace_with(f"[{a.get_text()}]({href})")
        return element.get_text(separator='\n').strip()
    except Exception:
        return element.get_text().strip()

def scrape_channel(username, lookback_days, max_pages, base_path, current_idx, total_channels):
    logger.info(f"[{current_idx}/{total_channels}] شروع پردازش کانال: @{username}")
    
    channel_dir = os.path.join(base_path, username)
    os.makedirs(channel_dir, exist_ok=True)
    
    time_threshold = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    all_messages = []
    last_msg_id = None
    reached_end = False
    pages_fetched = 0
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }

    # حلقه اسکرپینگ با محدودیت زمانی و محدودیت تعداد صفحات
    while not reached_end and pages_fetched < max_pages:
        url = f"https://t.me/s/{username}"
        if last_msg_id:
            url += f"?before={last_msg_id}"
        
        try:
            pages_fetched += 1
            logger.info(f"    در حال دریافت صفحه {pages_fetched} از حداکثر {max_pages} برای @{username}...")
            
            response = requests.get(url, headers=headers, timeout=15)
            if response.status_code == 429:
                logger.warning(f"    محدودیت نرخ (Rate Limit) توسط تلگرام! ۵ ثانیه صبر می‌کنیم...")
                time.sleep(5)
                pages_fetched -= 1 # کسر کردن صفحه چون با موفقیت دریافت نشد
                continue
            elif response.status_code != 200:
                logger.error(f"    خطا در اتصال به @{username}: کد وضعیت {response.status_code}")
                break

            soup = BeautifulSoup(response.text, 'lxml')
            messages = soup.find_all('div', class_='tgme_widget_message')
            
            if not messages:
                logger.info(f"    پیامی در این بخش از تاریخچه @{username} یافت نشد.")
                break

            for msg in reversed(messages):
                msg_id_attr = msg.get('data-post')
                if msg_id_attr:
                    last_msg_id = msg_id_attr.split('/')[-1]

                time_element = msg.find('time', class_='time')
                if not time_element: continue
                
                msg_date = datetime.fromisoformat(time_element.get('datetime').replace('Z', '+00:00'))
                
                if msg_date < time_threshold:
                    logger.info(f"    به حد زمانی تعیین شده ({lookback_days} روز) رسیدیم.")
                    reached_end = True
                    break
                
                text_area = msg.find('div', class_='tgme_widget_message_text')
                content = html_to_md(text_area) if text_area else ""
                
                if content:
                    is_forwarded = msg.find('div', class_='tgme_widget_message_forwarded_from')
                    all_messages.append({
                        'date': msg_date,
                        'content': content,
                        'forwarded': is_forwarded is not None
                    })
            
            # چک کردن اینکه آیا به سقف تعداد صفحات رسیده‌ایم یا خیر
            if pages_fetched >= max_pages and not reached_end:
                logger.warning(f"    به سقف مجاز صفحات ({max_pages} صفحه) رسیدیم. توقف اسکرپینگ برای @{username}.")
                break

            if not reached_end:
                time.sleep(1.5) # وقفه ایمن برای جلوگیری از بلاک

        except Exception as e:
            logger.error(f"    خطای غیرمنتظره در پردازش صفحه: {e}")
            break

    if all_messages:
        # حذف تکراری‌ها و ذخیره
        unique_messages = []
        seen = set()
        for m in all_messages:
            identifier = f"{m['date']}_{m['content'][:50]}"
            if identifier not in seen:
                unique_messages.append(m)
                seen.add(identifier)

        try:
            # پاکسازی فایل‌های md قدیمی که باعث ارور گیت‌هاب می‌شدند
            old_md_file = os.path.join(channel_dir, "messages.md")
            if os.path.exists(old_md_file):
                os.remove(old_md_file)

            # ذخیره با فرمت جدید txt
            with open(os.path.join(channel_dir, "messages.txt"), "w", encoding="utf-8") as f:
                f.write(f"# آرشیو کانال: @{username}\n")
                f.write(f"بروزرسانی: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} UTC\n\n")
                for m in unique_messages:
                    f.write(f"### 🕒 {m['date'].strftime('%Y-%m-%d %H:%M:%S')} UTC\n")
                    if m['forwarded']: f.write(f"> ↪️ **Forwarded**\n\n")
                    f.write(f"{m['content']}\n\n---\n\n")
            logger.info(f"✅ موفقیت: {len(unique_messages)} پیام جدید برای @{username} ذخیره شد.")
        except Exception as e:
            logger.error(f"❌ خطا در نوشتن فایل برای @{username}: {e}")
    else:
        logger.warning(f"⚠️ هیچ پیامی پیدا نشد.")

def main():
    start_time = time.time()
    logger.info("🚀 شروع فرآیند اسکرپینگ تلگرام...")
    
    settings = load_settings()
    usernames = load_channels()
    
    if not usernames:
        logger.error("لیست کانال‌ها خالی است. عملیات متوقف شد.")
        return

    scraping_cfg = settings.get('scraping', {})
    lookback_days = scraping_cfg.get('lookback_days', 2)
    max_pages = scraping_cfg.get('max_pages', 30)
    base_path = settings.get('storage', {}).get('base_path', 'src/telegram')
    
    total = len(usernames)
    for idx, username in enumerate(usernames, 1):
        scrape_channel(username, lookback_days, max_pages, base_path, idx, total)
        if idx < total:
            logger.info(f"استراحت کوتاه قبل از کانال بعدی...")
            time.sleep(3)

    duration = round(time.time() - start_time, 2)
    logger.info(f"🏁 عملیات با موفقیت به پایان رسید. زمان کل: {duration} ثانیه.")

if __name__ == "__main__":
    main()
