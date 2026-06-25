## 题目描述

给你一个整数数组 `cards` ，其中 `cards[i]` 表示第 `i` 张卡牌的 **值** 。如果两张卡牌的值相同，则认为这一对卡牌 **匹配** 。

返回你必须拿起的最小连续卡牌数，以使在拿起的卡牌中有一对匹配的卡牌。如果无法得到一对匹配的卡牌，返回 `-1` 。

 

**示例 1：**

```
**输入：**cards = [3,4,2,3,4,7]
**输出：**4
**解释：**拿起卡牌 [3,4,2,3] 将会包含一对值为 3 的匹配卡牌。注意，拿起 [4,2,3,4] 也是最优方案。
```

**示例 2：**

```
**输入：**cards = [1,0,5,3]
**输出：**-1
**解释：**无法找出含一对匹配卡牌的一组连续卡牌。
```

 

**提示：**

	- `1 <= cards.length <= 105`

	- `0 <= cards[i] <= 106`

## 解法

```java
class Solution {
    public int minimumCardPickup(int[] cards) {
        int n = cards.length;
        // 根据题目范围 1 <= cards[i] <= 10^6
        int[] last = new int[1000001]; 
        Arrays.fill(last, -1); // 填充 -1 表示未出现
        
        int min = Integer.MAX_VALUE;
        for (int i = 0; i < n; i++) {
            int card = cards[i];
            if (last[card] != -1) {
                min = Math.min(min, i - last[card] );
            }
            last[card] = i;
        }
        return min == Integer.MAX_VALUE ? -1 : min+1;
    }
}
```
