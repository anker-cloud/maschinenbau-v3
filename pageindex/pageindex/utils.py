import litellm
import logging
import os
import textwrap
from datetime import datetime
import time
import json
import json_repair
import PyPDF2
import copy
import asyncio
import random as _random
import pymupdf
from io import BytesIO
from dotenv import load_dotenv
load_dotenv()
import yaml
from pathlib import Path
from types import SimpleNamespace as config

# Backward compatibility: support CHATGPT_API_KEY as alias for OPENAI_API_KEY
if not os.getenv("OPENAI_API_KEY") and os.getenv("CHATGPT_API_KEY"):
    os.environ["OPENAI_API_KEY"] = os.getenv("CHATGPT_API_KEY")

litellm.drop_params = True

# Shared rate-limited queue for all async LLM calls within a document index run.
# _MAX_CONCURRENT caps simultaneous Bedrock requests; prevents TPM burst exhaustion.
_MAX_CONCURRENT = 5
_LLM_SEMAPHORE: asyncio.Semaphore | None = None


def _get_semaphore() -> asyncio.Semaphore:
    """Return the module-level semaphore, creating it bound to the current event loop."""
    global _LLM_SEMAPHORE
    # Recreate if None — asyncio.run() in page_index_main creates a fresh event loop
    # each invocation, which invalidates any previously created Semaphore.
    if _LLM_SEMAPHORE is None:
        _LLM_SEMAPHORE = asyncio.Semaphore(_MAX_CONCURRENT)
    return _LLM_SEMAPHORE


async def _sem_acompletion(model: str, prompt: str) -> str:
    """llm_acompletion gated by the shared concurrency semaphore.
    Only _MAX_CONCURRENT calls run at a time; others wait in queue.
    """
    async with _get_semaphore():
        return await llm_acompletion(model, prompt)


def count_tokens(text, model=None):
    if not text:
        return 0
    return litellm.token_counter(model=model, text=text)


_RATE_LIMIT_ERRORS = (litellm.RateLimitError,)
_TRANSIENT_ERRORS  = (litellm.Timeout, litellm.ServiceUnavailableError,
                      litellm.InternalServerError, litellm.APIConnectionError)
_FATAL_ERRORS      = (litellm.BadRequestError, litellm.AuthenticationError,
                      litellm.PermissionDeniedError, litellm.ContextWindowExceededError)


def _compute_backoff_delay(attempt: int, is_rate_limit: bool) -> float:
    """Jittered exponential backoff.
    Rate limit (429): 5s base, 60s cap — needs full TPM window reset.
    Transient error: 1s base, 4s cap — quick recovery.
    Jitter 50-100%: prevents thundering herd when semaphore releases multiple waiters.
    """
    base, cap = (5.0, 60.0) if is_rate_limit else (1.0, 4.0)
    return min(cap, base * (2 ** attempt)) * _random.uniform(0.5, 1.0)


def _extract_retry_after(exc: Exception) -> float | None:
    """Read Retry-After header from litellm exception if present."""
    try:
        h = getattr(getattr(exc, 'response', None), 'headers', None)
        val = h and (h.get('retry-after') or h.get('Retry-After'))
        return float(val) if val else None
    except Exception:
        return None


_MAX_RATE_LIMIT_RETRIES = 15   # 15 x ~60s = ~15 min ceiling
_MAX_TRANSIENT_RETRIES = 10


def llm_completion(model, prompt, chat_history=None, return_finish_reason=False):
    if model:
        model = model.removeprefix("litellm/")
    messages = (list(chat_history) + [{"role": "user", "content": prompt}]
                if chat_history else [{"role": "user", "content": prompt}])
    attempt = 0
    while True:
        try:
            resp = litellm.completion(model=model, messages=messages, temperature=0)
            content = resp.choices[0].message.content
            if return_finish_reason:
                fr = "max_output_reached" if resp.choices[0].finish_reason == "length" else "finished"
                return content, fr
            return content
        except _RATE_LIMIT_ERRORS as e:
            if attempt >= _MAX_RATE_LIMIT_RETRIES:
                logging.error("Max rate-limit retries reached")
                return ("", "error") if return_finish_reason else ""
            wait = _extract_retry_after(e) or _compute_backoff_delay(attempt, True)
            logging.warning("Rate limit (attempt %d/%d), sleeping %.1fs", attempt + 1, _MAX_RATE_LIMIT_RETRIES, wait)
            time.sleep(wait)
        except _TRANSIENT_ERRORS as e:
            if attempt >= _MAX_TRANSIENT_RETRIES:
                logging.error("Max transient retries reached")
                return ("", "error") if return_finish_reason else ""
            wait = _compute_backoff_delay(attempt, False)
            logging.warning("Transient error (attempt %d/%d), sleeping %.1fs", attempt + 1, _MAX_TRANSIENT_RETRIES, wait)
            time.sleep(wait)
        except _FATAL_ERRORS as e:
            logging.error("Non-retryable LLM error: %s", e)
            return ("", "error") if return_finish_reason else ""
        except Exception as e:
            if attempt >= _MAX_TRANSIENT_RETRIES:
                logging.error("Max retries (unknown error): %s", e)
                return ("", "error") if return_finish_reason else ""
            wait = _compute_backoff_delay(attempt, False)
            logging.warning("Unknown error (attempt %d/%d), sleeping %.1fs: %s", attempt + 1, _MAX_TRANSIENT_RETRIES, wait, e)
            time.sleep(wait)
        attempt += 1


async def llm_acompletion(model: str, prompt: str) -> str:
    if model:
        model = model.removeprefix("litellm/")
    messages = [{"role": "user", "content": prompt}]
    attempt = 0
    while True:
        try:
            resp = await litellm.acompletion(model=model, messages=messages, temperature=0)
            return resp.choices[0].message.content
        except _RATE_LIMIT_ERRORS as e:
            if attempt >= _MAX_RATE_LIMIT_RETRIES:
                logging.error("Max rate-limit retries reached (async)")
                return ""
            wait = _extract_retry_after(e) or _compute_backoff_delay(attempt, True)
            logging.warning("Rate limit async (attempt %d/%d), sleeping %.1fs", attempt + 1, _MAX_RATE_LIMIT_RETRIES, wait)
            await asyncio.sleep(wait)
        except _TRANSIENT_ERRORS as e:
            if attempt >= _MAX_TRANSIENT_RETRIES:
                logging.error("Max transient retries reached (async)")
                return ""
            wait = _compute_backoff_delay(attempt, False)
            logging.warning("Transient error async (attempt %d/%d), sleeping %.1fs", attempt + 1, _MAX_TRANSIENT_RETRIES, wait)
            await asyncio.sleep(wait)
        except _FATAL_ERRORS as e:
            logging.error("Non-retryable LLM error (async): %s", e)
            return ""
        except Exception as e:
            if attempt >= _MAX_TRANSIENT_RETRIES:
                logging.error("Max retries async (unknown error): %s", e)
                return ""
            wait = _compute_backoff_delay(attempt, False)
            logging.warning("Unknown error async (attempt %d/%d), sleeping %.1fs: %s", attempt + 1, _MAX_TRANSIENT_RETRIES, wait, e)
            await asyncio.sleep(wait)
        attempt += 1


def get_json_content(response):
    start_idx = response.find("```json")
    if start_idx != -1:
        start_idx += 7
        response = response[start_idx:]

    end_idx = response.rfind("```")
    if end_idx != -1:
        response = response[:end_idx]

    json_content = response.strip()
    return json_content


def extract_partial_json_array(raw: str) -> list:
    """Salvage complete objects from a truncated JSON array.

    When the LLM output is cut off mid-object (e.g. ``[{"a":1},{"b":2},{"c":``),
    this function finds the last complete ``}`` and attempts to parse everything
    up to (and including) it as a JSON array.

    Returns a list of salvaged items, or ``[]`` if nothing can be recovered.
    """
    last_brace = raw.rfind("}")
    if last_brace == -1:
        return []

    candidate = raw[: last_brace + 1] + "]"
    # Fast path
    try:
        result = json.loads(candidate)
        if isinstance(result, list):
            logging.info("extract_partial_json_array: salvaged %d item(s)", len(result))
            return result
    except json.JSONDecodeError:
        pass

    # Slow path — json_repair
    try:
        result = json_repair.loads(candidate)
        if isinstance(result, list):
            logging.info(
                "extract_partial_json_array (json_repair): salvaged %d item(s)", len(result)
            )
            return result
    except Exception:
        pass

    logging.warning("extract_partial_json_array: could not salvage any items")
    return []


def extract_json(
    content: str,
    expected_type: type = dict,
    context: str = "",
) -> "dict | list":
    """Parse LLM output as JSON with a multi-stage recovery chain.

    Recovery order:
    1. Strip markdown fences (``json ... `` or `` ... ``).
    2. Replace Python literals (``None``, ``True``, ``False``).
    3. Normalise whitespace.
    4. ``json.loads()`` — fast path for well-formed output.
    5. ``json_repair.loads()`` — handles trailing commas, missing commas,
       unescaped characters, single quotes, etc.
    6. If ``expected_type is list`` and the content starts with ``[``:
       call ``extract_partial_json_array()`` to salvage completed items.
    7. Log the failure (with ``context`` label and full raw content) and
       return the appropriate empty sentinel.

    The function *never* returns the wrong type: if parsing succeeds but
    yields the wrong Python type a warning is logged and the correct
    empty sentinel is returned.
    """
    _EMPTY: "dict | list" = [] if expected_type is list else {}

    # ── Step 1: strip markdown fences ────────────────────────────────────────
    json_content = content.strip()
    start_fence = json_content.find("```json")
    if start_fence != -1:
        json_content = json_content[start_fence + 7:]
        end_fence = json_content.rfind("```")
        if end_fence != -1:
            json_content = json_content[:end_fence]
    else:
        start_fence = json_content.find("```")
        if start_fence != -1:
            json_content = json_content[start_fence + 3:]
            end_fence = json_content.rfind("```")
            if end_fence != -1:
                json_content = json_content[:end_fence]

    json_content = json_content.strip()

    # ── Step 2: replace Python literals ──────────────────────────────────────
    json_content = json_content.replace("None", "null")
    json_content = json_content.replace("True", "true")
    json_content = json_content.replace("False", "false")

    # ── Step 3: normalise whitespace ─────────────────────────────────────────
    json_content = json_content.replace("\n", " ").replace("\r", " ")
    json_content = " ".join(json_content.split())

    # ── Step 4: fast path ────────────────────────────────────────────────────
    try:
        result = json.loads(json_content)
        if not isinstance(result, expected_type):
            logging.warning(
                "extract_json [%s]: type mismatch — expected %s, got %s; returning empty sentinel",
                context,
                expected_type.__name__,
                type(result).__name__,
            )
            return _EMPTY
        return result
    except json.JSONDecodeError:
        pass

    # ── Step 5: json_repair ───────────────────────────────────────────────────
    try:
        result = json_repair.loads(json_content)
        if not isinstance(result, expected_type):
            logging.warning(
                "extract_json (json_repair) [%s]: type mismatch — expected %s, got %s; returning empty sentinel",
                context,
                expected_type.__name__,
                type(result).__name__,
            )
            return _EMPTY
        return result
    except Exception:
        pass

    # ── Step 6: partial-array salvage ────────────────────────────────────────
    if expected_type is list and json_content.lstrip().startswith("["):
        salvaged = extract_partial_json_array(json_content)
        if salvaged:
            return salvaged

    # ── Step 7: log and return empty sentinel ─────────────────────────────────
    logging.error(
        "extract_json [%s]: all recovery attempts failed; returning empty %s.\nRaw content:\n%s",
        context,
        expected_type.__name__,
        content,
    )
    return _EMPTY


def llm_completion_json(
    model: str,
    prompt: str,
    expected_type: type = list,
    max_retries: int = 2,
    context: str = "",
) -> "dict | list":
    """Call the LLM and parse the response as JSON, retrying on bad JSON.

    Uses ``llm_completion`` (synchronous) to match the calling convention of
    synchronous functions in ``page_index.py``.

    On each attempt:
    1. Call ``llm_completion`` with ``return_finish_reason=True``.
    2. Raise if ``finish_reason != 'finished'`` (truncated / error).
    3. Parse with ``extract_json``; if the result is an empty sentinel *and*
       the raw response was non-empty *and* retries remain, send a correction
       prompt asking Claude to return only corrected JSON.

    Returns the parsed result (list or dict) or the appropriate empty sentinel.
    """
    _EMPTY: "dict | list" = [] if expected_type is list else {}

    response, finish_reason = llm_completion(model=model, prompt=prompt, return_finish_reason=True)

    if finish_reason != "finished":
        raise Exception(f"LLM finish reason: {finish_reason}")

    result = extract_json(response, expected_type=expected_type, context=context)

    # If we got an empty sentinel but had content, try a correction prompt.
    if result == _EMPTY and response and max_retries > 0:
        type_label = "array" if expected_type is list else "object"
        correction_prompt = (
            "Your previous response contained invalid JSON that could not be parsed.\n\n"
            f"Your response was:\n{response[:2000]}\n\n"
            f"Please return ONLY the corrected JSON {type_label}. No markdown, no commentary."
        )
        logging.warning(
            "llm_completion_json [%s]: retrying with correction prompt (%d retries left)",
            context,
            max_retries - 1,
        )
        return llm_completion_json(
            model=model,
            prompt=correction_prompt,
            expected_type=expected_type,
            max_retries=max_retries - 1,
            context=context,
        )

    return result

def write_node_id(data, node_id=0):
    if isinstance(data, dict):
        data['node_id'] = str(node_id).zfill(4)
        node_id += 1
        for key in list(data.keys()):
            if 'nodes' in key:
                node_id = write_node_id(data[key], node_id)
    elif isinstance(data, list):
        for index in range(len(data)):
            node_id = write_node_id(data[index], node_id)
    return node_id

def get_nodes(structure):
    if isinstance(structure, dict):
        structure_node = copy.deepcopy(structure)
        structure_node.pop('nodes', None)
        nodes = [structure_node]
        for key in list(structure.keys()):
            if 'nodes' in key:
                nodes.extend(get_nodes(structure[key]))
        return nodes
    elif isinstance(structure, list):
        nodes = []
        for item in structure:
            nodes.extend(get_nodes(item))
        return nodes

def structure_to_list(structure):
    if isinstance(structure, dict):
        nodes = []
        nodes.append(structure)
        if 'nodes' in structure:
            nodes.extend(structure_to_list(structure['nodes']))
        return nodes
    elif isinstance(structure, list):
        nodes = []
        for item in structure:
            nodes.extend(structure_to_list(item))
        return nodes


def get_leaf_nodes(structure):
    if isinstance(structure, dict):
        if not structure['nodes']:
            structure_node = copy.deepcopy(structure)
            structure_node.pop('nodes', None)
            return [structure_node]
        else:
            leaf_nodes = []
            for key in list(structure.keys()):
                if 'nodes' in key:
                    leaf_nodes.extend(get_leaf_nodes(structure[key]))
            return leaf_nodes
    elif isinstance(structure, list):
        leaf_nodes = []
        for item in structure:
            leaf_nodes.extend(get_leaf_nodes(item))
        return leaf_nodes

def is_leaf_node(data, node_id):
    # Helper function to find the node by its node_id
    def find_node(data, node_id):
        if isinstance(data, dict):
            if data.get('node_id') == node_id:
                return data
            for key in data.keys():
                if 'nodes' in key:
                    result = find_node(data[key], node_id)
                    if result:
                        return result
        elif isinstance(data, list):
            for item in data:
                result = find_node(item, node_id)
                if result:
                    return result
        return None

    # Find the node with the given node_id
    node = find_node(data, node_id)

    # Check if the node is a leaf node
    if node and not node.get('nodes'):
        return True
    return False

def get_last_node(structure):
    return structure[-1]


def extract_text_from_pdf(pdf_path):
    pdf_reader = PyPDF2.PdfReader(pdf_path)
    ###return text not list
    text=""
    for page_num in range(len(pdf_reader.pages)):
        page = pdf_reader.pages[page_num]
        text+=page.extract_text()
    return text

def get_pdf_title(pdf_path):
    pdf_reader = PyPDF2.PdfReader(pdf_path)
    meta = pdf_reader.metadata
    title = meta.title if meta and meta.title else 'Untitled'
    return title

def get_text_of_pages(pdf_path, start_page, end_page, tag=True):
    pdf_reader = PyPDF2.PdfReader(pdf_path)
    text = ""
    for page_num in range(start_page-1, end_page):
        page = pdf_reader.pages[page_num]
        page_text = page.extract_text()
        if tag:
            text += f"<start_index_{page_num+1}>\n{page_text}\n<end_index_{page_num+1}>\n"
        else:
            text += page_text
    return text

def get_first_start_page_from_text(text):
    start_page = -1
    start_page_match = re.search(r'<start_index_(\d+)>', text)
    if start_page_match:
        start_page = int(start_page_match.group(1))
    return start_page

def get_last_start_page_from_text(text):
    start_page = -1
    # Find all matches of start_index tags
    start_page_matches = re.finditer(r'<start_index_(\d+)>', text)
    # Convert iterator to list and get the last match if any exist
    matches_list = list(start_page_matches)
    if matches_list:
        start_page = int(matches_list[-1].group(1))
    return start_page


def sanitize_filename(filename, replacement='-'):
    # In Linux, only '/' and '\0' (null) are invalid in filenames.
    # Null can't be represented in strings, so we only handle '/'.
    return filename.replace('/', replacement)

def get_pdf_name(pdf_path):
    # Extract PDF name
    if isinstance(pdf_path, str):
        pdf_name = os.path.basename(pdf_path)
    elif isinstance(pdf_path, BytesIO):
        pdf_reader = PyPDF2.PdfReader(pdf_path)
        meta = pdf_reader.metadata
        pdf_name = meta.title if meta and meta.title else 'Untitled'
        pdf_name = sanitize_filename(pdf_name)
    return pdf_name


class JsonLogger:
    def __init__(self, file_path):
        # Extract PDF name for logger name
        pdf_name = get_pdf_name(file_path)

        current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.filename = f"{pdf_name}_{current_time}.json"
        os.makedirs("./logs", exist_ok=True)
        # Initialize empty list to store all messages
        self.log_data = []

    def log(self, level, message, **kwargs):
        if isinstance(message, dict):
            self.log_data.append(message)
        else:
            self.log_data.append({'message': message})
        # Add new message to the log data

        # Write entire log data to file
        with open(self._filepath(), "w") as f:
            json.dump(self.log_data, f, indent=2)

    def info(self, message, **kwargs):
        self.log("INFO", message, **kwargs)

    def error(self, message, **kwargs):
        self.log("ERROR", message, **kwargs)

    def debug(self, message, **kwargs):
        self.log("DEBUG", message, **kwargs)

    def exception(self, message, **kwargs):
        kwargs["exception"] = True
        self.log("ERROR", message, **kwargs)

    def _filepath(self):
        return os.path.join("logs", self.filename)




def list_to_tree(data):
    def get_parent_structure(structure):
        """Helper function to get the parent structure code"""
        if not structure:
            return None
        parts = str(structure).split('.')
        return '.'.join(parts[:-1]) if len(parts) > 1 else None

    # First pass: Create nodes and track parent-child relationships
    nodes = {}
    root_nodes = []

    for item in data:
        structure = item.get('structure')
        node = {
            'title': item.get('title'),
            'start_index': item.get('start_index'),
            'end_index': item.get('end_index'),
            'nodes': []
        }

        nodes[structure] = node

        # Find parent
        parent_structure = get_parent_structure(structure)

        if parent_structure:
            # Add as child to parent if parent exists
            if parent_structure in nodes:
                nodes[parent_structure]['nodes'].append(node)
            else:
                root_nodes.append(node)
        else:
            # No parent, this is a root node
            root_nodes.append(node)

    # Helper function to clean empty children arrays
    def clean_node(node):
        if not node['nodes']:
            del node['nodes']
        else:
            for child in node['nodes']:
                clean_node(child)
        return node

    # Clean and return the tree
    return [clean_node(node) for node in root_nodes]

def add_preface_if_needed(data):
    if not isinstance(data, list) or not data:
        return data

    if data[0]['physical_index'] is not None and data[0]['physical_index'] > 1:
        preface_node = {
            "structure": "0",
            "title": "Preface",
            "physical_index": 1,
        }
        data.insert(0, preface_node)
    return data



def get_page_tokens(pdf_path, model=None, pdf_parser="PyPDF2"):
    if pdf_parser == "PyPDF2":
        pdf_reader = PyPDF2.PdfReader(pdf_path)
        page_list = []
        for page_num in range(len(pdf_reader.pages)):
            page = pdf_reader.pages[page_num]
            page_text = page.extract_text()
            token_length = litellm.token_counter(model=model, text=page_text)
            page_list.append((page_text, token_length))
        return page_list
    elif pdf_parser == "PyMuPDF":
        if isinstance(pdf_path, BytesIO):
            pdf_stream = pdf_path
            doc = pymupdf.open(stream=pdf_stream, filetype="pdf")
        elif isinstance(pdf_path, str) and os.path.isfile(pdf_path) and pdf_path.lower().endswith(".pdf"):
            doc = pymupdf.open(pdf_path)
        page_list = []
        for page in doc:
            page_text = page.get_text()
            token_length = litellm.token_counter(model=model, text=page_text)
            page_list.append((page_text, token_length))
        return page_list
    else:
        raise ValueError(f"Unsupported PDF parser: {pdf_parser}")



def get_text_of_pdf_pages(pdf_pages, start_page, end_page):
    text = ""
    for page_num in range(start_page-1, end_page):
        text += pdf_pages[page_num][0]
    return text

def get_text_of_pdf_pages_with_labels(pdf_pages, start_page, end_page):
    text = ""
    for page_num in range(start_page-1, end_page):
        text += f"<physical_index_{page_num+1}>\n{pdf_pages[page_num][0]}\n<physical_index_{page_num+1}>\n"
    return text

def get_number_of_pages(pdf_path):
    pdf_reader = PyPDF2.PdfReader(pdf_path)
    num = len(pdf_reader.pages)
    return num



def post_processing(structure, end_physical_index):
    # First convert page_number to start_index in flat list
    for i, item in enumerate(structure):
        item['start_index'] = item.get('physical_index')
        if i < len(structure) - 1:
            if structure[i + 1].get('appear_start') == 'yes':
                item['end_index'] = structure[i + 1]['physical_index']-1
            else:
                item['end_index'] = structure[i + 1]['physical_index']
        else:
            item['end_index'] = end_physical_index
    tree = list_to_tree(structure)
    if len(tree)!=0:
        return tree
    else:
        ### remove appear_start
        for node in structure:
            node.pop('appear_start', None)
            node.pop('physical_index', None)
        return structure

def clean_structure_post(data):
    if isinstance(data, dict):
        data.pop('page_number', None)
        data.pop('start_index', None)
        data.pop('end_index', None)
        if 'nodes' in data:
            clean_structure_post(data['nodes'])
    elif isinstance(data, list):
        for section in data:
            clean_structure_post(section)
    return data

def remove_fields(data, fields=['text']):
    if isinstance(data, dict):
        return {k: remove_fields(v, fields)
            for k, v in data.items() if k not in fields}
    elif isinstance(data, list):
        return [remove_fields(item, fields) for item in data]
    return data

def print_toc(tree, indent=0):
    for node in tree:
        print('  ' * indent + node['title'])
        if node.get('nodes'):
            print_toc(node['nodes'], indent + 1)

def print_json(data, max_len=40, indent=2):
    def simplify_data(obj):
        if isinstance(obj, dict):
            return {k: simplify_data(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [simplify_data(item) for item in obj]
        elif isinstance(obj, str) and len(obj) > max_len:
            return obj[:max_len] + '...'
        else:
            return obj

    simplified = simplify_data(data)
    print(json.dumps(simplified, indent=indent, ensure_ascii=False))


def remove_structure_text(data):
    if isinstance(data, dict):
        data.pop('text', None)
        if 'nodes' in data:
            remove_structure_text(data['nodes'])
    elif isinstance(data, list):
        for item in data:
            remove_structure_text(item)
    return data


def check_token_limit(structure, limit=110000):
    list = structure_to_list(structure)
    for node in list:
        num_tokens = count_tokens(node['text'], model=None)
        if num_tokens > limit:
            print(f"Node ID: {node['node_id']} has {num_tokens} tokens")
            print("Start Index:", node['start_index'])
            print("End Index:", node['end_index'])
            print("Title:", node['title'])
            print("\n")


def convert_physical_index_to_int(data):
    if isinstance(data, list):
        for i in range(len(data)):
            # Check if item is a dictionary and has 'physical_index' key
            if isinstance(data[i], dict) and 'physical_index' in data[i]:
                if isinstance(data[i]['physical_index'], str):
                    if data[i]['physical_index'].startswith('<physical_index_'):
                        data[i]['physical_index'] = int(data[i]['physical_index'].split('_')[-1].rstrip('>').strip())
                    elif data[i]['physical_index'].startswith('physical_index_'):
                        data[i]['physical_index'] = int(data[i]['physical_index'].split('_')[-1].strip())
    elif isinstance(data, str):
        if data.startswith('<physical_index_'):
            data = int(data.split('_')[-1].rstrip('>').strip())
        elif data.startswith('physical_index_'):
            data = int(data.split('_')[-1].strip())
        # Check data is int
        if isinstance(data, int):
            return data
        else:
            return None
    return data


def convert_page_to_int(data):
    for item in data:
        if 'page' in item and isinstance(item['page'], str):
            try:
                item['page'] = int(item['page'])
            except ValueError:
                # Keep original value if conversion fails
                pass
    return data


def add_node_text(node, pdf_pages):
    if isinstance(node, dict):
        start_page = node.get('start_index')
        end_page = node.get('end_index')
        node['text'] = get_text_of_pdf_pages(pdf_pages, start_page, end_page)
        if 'nodes' in node:
            add_node_text(node['nodes'], pdf_pages)
    elif isinstance(node, list):
        for index in range(len(node)):
            add_node_text(node[index], pdf_pages)
    return


def add_node_text_with_labels(node, pdf_pages):
    if isinstance(node, dict):
        start_page = node.get('start_index')
        end_page = node.get('end_index')
        node['text'] = get_text_of_pdf_pages_with_labels(pdf_pages, start_page, end_page)
        if 'nodes' in node:
            add_node_text_with_labels(node['nodes'], pdf_pages)
    elif isinstance(node, list):
        for index in range(len(node)):
            add_node_text_with_labels(node[index], pdf_pages)
    return


async def generate_node_summary(node, model=None):
    prompt = f"""You are given a part of a document, your task is to generate a description of the partial document about what are main points covered in the partial document.

    Partial Document Text: {node['text']}

    Directly return the description, do not include any other text.
    """
    response = await _sem_acompletion(model, prompt)
    return response


async def generate_summaries_for_structure(structure, model=None):
    nodes = structure_to_list(structure)
    tasks = [generate_node_summary(node, model=model) for node in nodes]
    summaries = await asyncio.gather(*tasks)

    for node, summary in zip(nodes, summaries):
        node['summary'] = summary
    return structure


def create_clean_structure_for_description(structure):
    """
    Create a clean structure for document description generation,
    excluding unnecessary fields like 'text'.
    """
    if isinstance(structure, dict):
        clean_node = {}
        # Only include essential fields for description
        for key in ['title', 'node_id', 'summary', 'prefix_summary']:
            if key in structure:
                clean_node[key] = structure[key]

        # Recursively process child nodes
        if 'nodes' in structure and structure['nodes']:
            clean_node['nodes'] = create_clean_structure_for_description(structure['nodes'])

        return clean_node
    elif isinstance(structure, list):
        return [create_clean_structure_for_description(item) for item in structure]
    else:
        return structure


def generate_doc_description(structure, model=None):
    prompt = f"""Your are an expert in generating descriptions for a document.
    You are given a structure of a document. Your task is to generate a one-sentence description for the document, which makes it easy to distinguish the document from other documents.

    Document Structure: {structure}

    Directly return the description, do not include any other text.
    """
    response = llm_completion(model, prompt)
    return response


def reorder_dict(data, key_order):
    if not key_order:
        return data
    return {key: data[key] for key in key_order if key in data}


def format_structure(structure, order=None):
    if not order:
        return structure
    if isinstance(structure, dict):
        if 'nodes' in structure:
            structure['nodes'] = format_structure(structure['nodes'], order)
        if not structure.get('nodes'):
            structure.pop('nodes', None)
        structure = reorder_dict(structure, order)
    elif isinstance(structure, list):
        structure = [format_structure(item, order) for item in structure]
    return structure


class ConfigLoader:
    def __init__(self, default_path: str = None):
        if default_path is None:
            default_path = Path(__file__).parent / "config.yaml"
        self._default_dict = self._load_yaml(default_path)

    @staticmethod
    def _load_yaml(path):
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}

    def _validate_keys(self, user_dict):
        unknown_keys = set(user_dict) - set(self._default_dict)
        if unknown_keys:
            raise ValueError(f"Unknown config keys: {unknown_keys}")

    def load(self, user_opt=None) -> config:
        """
        Load the configuration, merging user options with default values.
        """
        if user_opt is None:
            user_dict = {}
        elif isinstance(user_opt, config):
            user_dict = vars(user_opt)
        elif isinstance(user_opt, dict):
            user_dict = user_opt
        else:
            raise TypeError("user_opt must be dict, config(SimpleNamespace) or None")

        self._validate_keys(user_dict)
        merged = {**self._default_dict, **user_dict}
        return config(**merged)

def create_node_mapping(tree):
    """Create a flat dict mapping node_id to node for quick lookup."""
    mapping = {}
    def _traverse(nodes):
        for node in nodes:
            if node.get('node_id'):
                mapping[node['node_id']] = node
            if node.get('nodes'):
                _traverse(node['nodes'])
    _traverse(tree)
    return mapping

def print_tree(tree, indent=0):
    for node in tree:
        summary = node.get('summary') or node.get('prefix_summary', '')
        summary_str = f"  —  {summary[:60]}..." if summary else ""
        print('  ' * indent + f"[{node.get('node_id', '?')}] {node.get('title', '')}{summary_str}")
        if node.get('nodes'):
            print_tree(node['nodes'], indent + 1)

def print_wrapped(text, width=100):
    for line in text.splitlines():
        print(textwrap.fill(line, width=width))
