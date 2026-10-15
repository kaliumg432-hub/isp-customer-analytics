"""Generate synthetic M-Pesa Utility Account statements for the demo.

Every customer, receipt and amount here is invented. Account IDs use a
DEMO#### format so they can never be mistaken for real phone numbers.

Usage:  python tools/make_sample_data.py   (writes sample-data/*.csv)
"""
import csv, random, string, calendar, os
from datetime import datetime

random.seed(2026)
OUT = os.path.join(os.path.dirname(__file__), "..", "sample-data")
os.makedirs(OUT, exist_ok=True)

MONTHS = [(2026, 7, 31), (2026, 8, 31), (2026, 9, 30), (2026, 10, 14)]  # Oct is month-to-date
HOTSPOT_PRICES = [10, 20, 30, 50]
PPPOE_PLANS = [1500, 2000, 2500, 3500]
HEADER = ["Receipt No.", "Completion Time", "Initiation Time", "Details", "Transaction Status",
          "Paid In", "Withdrawn", "Balance", "Balance Confirmed", "Reason Type",
          "Other Party Info", "Linked Transaction ID", "A/C No.", "Currency"]

def receipt():
    return "T" + "".join(random.choices(string.ascii_uppercase + string.digits, k=9))

# ---- customer population -------------------------------------------------
# Each customer gets a type, a join month and a trajectory over the 4 months.
customers = []
cid = 1000
def add(kind, n, join_choices, traj_choices):
    global cid
    for _ in range(n):
        cid += 1
        customers.append({
            "id": f"DEMO{cid}", "kind": kind,
            "join": random.choice(join_choices),
            "traj": random.choice(traj_choices),
            "plan": random.choice(PPPOE_PLANS),
            "payday": random.randint(1, 28),
            "rate": random.uniform(3, 14),          # hotspot purchases / month
            "fav": random.choice(HOTSPOT_PRICES),
        })

add("hotspot", 170, [0, 0, 0, 1, 2, 3], ["stable", "stable", "growing", "declining", "churn"])
add("ppoe",     85, [0, 0, 0, 0, 1, 2, 3], ["stable", "stable", "stable", "upgrade", "churn", "late"])
add("mixed",    25, [0, 0, 1, 2],          ["stable", "growing", "declining"])

def hotspot_count(c, mi):
    k = mi - c["join"]
    r = c["rate"]
    if c["traj"] == "growing":   r *= 1 + 0.35 * k
    if c["traj"] == "declining": r *= max(0.15, 1 - 0.4 * k)
    if c["traj"] == "churn" and k >= 2: return 0
    return max(0, int(random.gauss(r, r * 0.25)))

rows_by_month = {mi: [] for mi in range(len(MONTHS))}
balance = 250000.0

for mi, (y, m, last_day) in enumerate(MONTHS):
    for c in customers:
        if mi < c["join"]:
            continue
        # hotspot purchases
        if c["kind"] in ("hotspot", "mixed"):
            n = round(hotspot_count(c, mi) * last_day / calendar.monthrange(y, m)[1])
            for _ in range(n):
                d = random.randint(1, last_day)
                h = random.choices(range(24), weights=[1,1,1,1,1,2,4,6,7,6,5,5,6,5,5,6,7,9,11,12,11,8,5,2])[0]
                amt = c["fav"] if random.random() < 0.7 else random.choice(HOTSPOT_PRICES)
                rows_by_month[mi].append((datetime(y, m, d, h, random.randint(0, 59), random.randint(0, 59)), amt, c["id"]))
        # monthly PPPoE payment
        if c["kind"] in ("ppoe", "mixed"):
            k = mi - c["join"]
            if c["traj"] == "churn" and k >= 2:
                continue
            plan = c["plan"]
            if c["traj"] == "upgrade" and k >= 2:
                plan = min(3500, plan + 1000)
            if c["kind"] == "mixed" and c["traj"] == "declining" and k >= 2:
                continue
            day = c["payday"] + (random.randint(4, 9) if c["traj"] == "late" else random.randint(-2, 2))
            day = min(max(1, day), calendar.monthrange(y, m)[1])
            if day > last_day:      # not yet due in the month-to-date file
                continue
            rows_by_month[mi].append((datetime(y, m, day, random.randint(7, 21), random.randint(0, 59), random.randint(0, 59)), plan, c["id"]))
    # a few payers who didn't enter an account number
    for _ in range(random.randint(6, 12)):
        d = random.randint(1, last_day)
        rows_by_month[mi].append((datetime(y, m, d, random.randint(8, 22), random.randint(0, 59), 0),
                                  random.choice([20, 30, 1500, 2000]), ""))

# ---- write one statement per month -----------------------------------------
for mi, (y, m, last_day) in enumerate(MONTHS):
    rows = sorted(rows_by_month[mi], key=lambda r: r[0])
    name = f"demo_utility_statement_{y}-{m:02d}.csv"
    with open(os.path.join(OUT, name), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Organisation Name", "DEMO ISP LTD (synthetic data)"])
        w.writerow(["Organisation Short Code", "000000"])
        w.writerow(["Time Period", f"From 01-{m:02d}-{y} 00:00:00 To {last_day:02d}-{m:02d}-{y} 23:59:59"])
        w.writerow([])
        w.writerow(HEADER)
        weekly = 0.0
        for i, (dt, amt, acc) in enumerate(rows):
            balance += amt
            weekly += amt
            ts = dt.strftime("%d-%m-%Y %H:%M:%S")
            w.writerow([receipt(), ts, ts, "Pay Bill Online", "Completed", f"{amt:.2f}", "", f"{balance:.2f}",
                        "true", "Pay Utility", "Demo customer", "", acc, "KES"])
            # occasional failed payment and weekly settlement sweep (the app skips both)
            if random.random() < 0.004:
                w.writerow([receipt(), ts, ts, "Pay Bill Online", "Failed", f"{amt:.2f}", "", f"{balance:.2f}",
                            "true", "Pay Utility", "Demo customer", "", acc, "KES"])
            if dt.weekday() == 0 and weekly > 20000 and dt.hour > 12:
                balance -= weekly
                w.writerow([receipt(), ts, ts, "Settlement", "Completed", "", f"{weekly:.2f}", f"{balance:.2f}",
                            "true", "Utility Account to Organization Settlement Account", "", "", "", "KES"])
                weekly = 0.0
    print(name, len(rows), "payments")
