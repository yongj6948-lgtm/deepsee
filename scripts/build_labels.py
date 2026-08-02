#!/usr/bin/env python3
"""Build label embeddings for the MobileCLIP2-S2 semantic tagger.

One-time build step: tokenizes a label list and runs the ONNX text encoder to
produce label_embeddings.json (label -> 512-d vector). The MCP server loads
only this JSON + the vision encoder at runtime (no tokenizer, no text model).

Run from this dir:  python build_labels.py
Output: label_embeddings.json (committed alongside the vision model)
"""
import json, os, warnings
warnings.filterwarnings("ignore")
import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

DIR = os.path.dirname(os.path.abspath(__file__))

# Broad label set so "any screenshot" (text-less or not) has a home: UI types,
# games, photos, documents, charts, code, media, abstract, etc.
LABELS = [
    # UI / screens
    "login page", "sign in screen", "sign up page", "registration form",
    "dashboard", "settings page", "profile page", "home screen",
    "search results", "chat conversation", "email inbox", "calendar",
    "menu", "notification panel", "error dialog", "confirmation dialog",
    "welcome screen", "loading screen", "phone screen", "tablet screen",
    "desktop screen", "web browser", "web page", "form", "table",
    "list", "card feed", "navigation menu", "video call",
    # apps / content
    "weather app", "fitness tracker", "bank app", "shopping page",
    "product page", "checkout", "receipt", "invoice", "streaming app",
    "messaging app", "music player", "video player", "photo gallery",
    "social media feed", "news article", "recipe", "presentation slide",
    "checklist", "todo list", "contact list",
    # technical
    "code editor", "code", "terminal", "command line", "spreadsheet",
    "diagram", "flowchart", "architecture diagram",
    # data / visualizations
    "map", "road map", "chart", "bar chart", "line graph", "pie chart",
    "heatmap", "timeline",
    # games / media
    "game", "game map", "strategy game", "puzzle game", "video game",
    # real-world / images
    "photo", "photograph", "portrait", "selfie", "landscape",
    "document", "article", "report", "letter", "book page",
    "artwork", "painting", "drawing", "illustration", "meme", "poster",
    "banner", "logo", "advertisement",
    # ambiguous
    "abstract", "abstract art", "empty screen", "black screen",
    "white screen", "texture", "pattern"
]

tok = AutoTokenizer.from_pretrained(DIR)
# CRITICAL: MobileCLIP2's text encoder has no_causal_mask — it pools over ALL
# tokens including padding. Padding with the EOS token (49407) makes every
# sequence dominated by EOS and collapses all labels to ~the same embedding.
# Pad with the model's pad_id (0) instead.
encs = tok(LABELS)
seqs = [list(s) for s in encs["input_ids"]]
input_ids = np.array([seq + [0] * (77 - len(seq)) for seq in seqs], dtype=np.int64)[:, :77]
print("tokenizer ok. ids shape", input_ids.shape)
print("sample 'login page' ids:", input_ids[0][:15].tolist())
print("decoded back:", tok.decode(input_ids[0], skip_special_tokens=True))

sess = ort.InferenceSession(os.path.join(DIR, "text.onnx"))
out = sess.run(None, {"input_ids": input_ids})[0]  # [N, 512]
print("embeddings shape", out.shape)

data = {label: out[i].tolist() for i, label in enumerate(LABELS)}
json.dump(data, open(os.path.join(DIR, "label_embeddings.json"), "w"))
print("saved label_embeddings.json:", len(data), "labels")
