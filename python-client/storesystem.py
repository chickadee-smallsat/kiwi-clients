# %%
from __future__ import annotations
from abc import ABC, abstractmethod
from typing import List, Tuple

from pandas import DataFrame

# %%


class StoreSystem(ABC):
    @abstractmethod
    def callback(self, evt) -> None:
        pass

    @abstractmethod
    def update(self, data: List[Tuple[int, DataFrame]]) -> None:
        pass

    @abstractmethod
    def close(self) -> None:
        pass
