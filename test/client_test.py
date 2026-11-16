import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("client", pathlib.Path(__file__).parents[1] / "scripts/bridge-client.py")
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)

class ClientTest(unittest.TestCase):
    def test_origin_and_token(self):
        self.assertEqual(client.configuration({"BUM_BRIDGE_URL":"https://example.workers.dev/", "BUM_BRIDGE_API_TOKEN":"x"*32})[0], "https://example.workers.dev")
    def test_fail_closed(self):
        for url in ["http://example.com", "https://user:pw@example.com", "https://example.com/path", "https://example.com?token=x", "https://example.com:444"]:
            with self.assertRaises(ValueError): client.configuration({"BUM_BRIDGE_URL":url,"BUM_BRIDGE_API_TOKEN":"x"*32})
        for token in ["", "short", "REPLACE"+"x"*32, "x"*32+"\n"]:
            with self.assertRaises(ValueError): client.configuration({"BUM_BRIDGE_URL":"https://example.com","BUM_BRIDGE_API_TOKEN":token})

if __name__ == '__main__': unittest.main()
