from pathlib import Path
import time
Path('started').write_text(str(time.time()))
time.sleep(20)
Path('finished').write_text(str(time.time()))
